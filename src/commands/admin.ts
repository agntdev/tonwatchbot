// Admin commands (docs/details.md §7).
//
// /admin_stats, /admin_users, /admin_alerts, /admin_export. The
// `adminOnly` middleware in src/middleware.ts already drops any /admin_*
// command from non-admins, so we only need to implement the happy paths.

import { inlineButton, inlineKeyboard, paginate } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";
import { InputFile } from "grammy";
import type { Ctx } from "../bot.js";
import type { Store } from "../store.js";

type Period = "24h" | "7d" | "30d";

function parsePeriod(s: string | undefined): Period {
  if (s === "7d" || s === "30d") return s;
  return "24h";
}

function periodMs(p: Period): number {
  if (p === "24h") return 24 * 60 * 60_000;
  if (p === "7d") return 7 * 24 * 60 * 60_000;
  return 30 * 24 * 60 * 60_000;
}

function periodToCsvSuffix(p: Period): string {
  return p;
}

function escapeCsv(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  return escapeCsv(String(v));
}

function fmtUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function registerAdmin(bot: Bot<Ctx>, store: Store): void {
  // ── /admin_stats ─────────────────────────────────────────────────────
  bot.command("admin_stats", async (ctx) => {
    const last24h = store.countAlertsSince(24 * 60 * 60_000);
    const topTokens = store.topTokensByAlerts(24 * 60 * 60_000, 5);
    const totalUsers = store.countUsers();
    const activeWatches = store.listAllEnabledWatches().length;
    const topLines = topTokens.length
      ? topTokens.map((t, i) => `  ${i + 1}. ${t.symbol} — ${t.alertCount}`).join("\n")
      : "  (no alerts in the last 24h)";
    await ctx.reply(
      `Admin stats (last 24h)\n` +
        `Users:        ${totalUsers}\n` +
        `Active watches: ${activeWatches}\n` +
        `Alerts sent:  ${last24h}\n` +
        `Top tokens (alerts):\n${topLines}`,
    );
  });

  // ── /admin_users [page] ──────────────────────────────────────────────
  bot.command("admin_users", async (ctx) => {
    const arg = ctx.message?.text?.replace(/^\/admin_users(@\w+)?\s*/, "").trim();
    const page = Math.max(1, Number(arg) || 1);
    const PAGE_SIZE = 20;
    const all = Array.from(store.users.values());
    const p = paginate(all, { page: page - 1, perPage: PAGE_SIZE, callbackPrefix: "admin_users" });
    if (p.pageItems.length === 0) {
      await ctx.reply("No users.");
      return;
    }
    const lines = p.pageItems.map((u, i) =>
      `${(p.page * PAGE_SIZE) + i + 1}. ${u.telegramChatId} — ${u.timezone ?? "(no tz)"} — ${store.listWatches(u.telegramChatId).length} watches`,
    );
    await ctx.reply(`Users (page ${p.page + 1} of ${p.totalPages}):\n${lines.join("\n")}`, {
      reply_markup: p.controls,
    });
  });

  // ── /admin_users pagination ──────────────────────────────────────────
  bot.callbackQuery(/^admin_users:(prev|next):(\d+)$/, async (ctx) => {
    const newPage = Number(ctx.match[2]) + 1; // paginate is 0-based
    const PAGE_SIZE = 20;
    const all = Array.from(store.users.values());
    const p = paginate(all, { page: newPage - 1, perPage: PAGE_SIZE, callbackPrefix: "admin_users" });
    if (p.pageItems.length === 0) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("No users.");
      return;
    }
    const lines = p.pageItems.map((u, i) =>
      `${(p.page * PAGE_SIZE) + i + 1}. ${u.telegramChatId} — ${u.timezone ?? "(no tz)"} — ${store.listWatches(u.telegramChatId).length} watches`,
    );
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Users (page ${p.page + 1} of ${p.totalPages}):\n${lines.join("\n")}`, {
      reply_markup: p.controls,
    });
  });

  // ── /admin_alerts <period> ───────────────────────────────────────────
  bot.command("admin_alerts", async (ctx) => {
    const arg = ctx.message?.text?.replace(/^\/admin_alerts(@\w+)?\s*/, "").trim();
    if (arg && !["24h", "7d", "30d"].includes(arg)) {
      await ctx.reply("Usage: /admin_alerts <24h|7d|30d>");
      return;
    }
    const period = parsePeriod(arg);
    const topTokens = store.topTokensByAlerts(periodMs(period), 10);
    const recent = store.recentAlertEvents(20);
    const topLines = topTokens.length
      ? topTokens.map((t, i) => `  ${i + 1}. ${t.symbol} — ${t.alertCount} alerts, ${t.uniqueUserCount} users`).join("\n")
      : "  (none)";
    const recentLines = recent.length
      ? recent.map((e) => `  ${fmtUtc(e.firedAt)} ${store.getToken(e.tokenId ?? "")?.symbol ?? "???"} ${e.type} ${e.userId}`).join("\n")
      : "  (no recent events)";
    await ctx.reply(
      `Admin alerts (last ${period})\n` +
        `Top tokens:\n${topLines}\n` +
        `\nRecent events (latest 20):\n${recentLines}`,
    );
  });

  // ── /admin_export <users|alerts> <period> ────────────────────────────
  bot.command("admin_export", async (ctx) => {
    const arg = ctx.message?.text?.replace(/^\/admin_export(@\w+)?\s*/, "").trim() ?? "";
    const parts = arg.split(/\s+/);
    if (parts.length < 2 || !["users", "alerts"].includes(parts[0]!) || !["24h", "7d", "30d"].includes(parts[1]!)) {
      await ctx.reply("Usage: /admin_export <users|alerts> <24h|7d|30d>");
      return;
    }
    const kind = parts[0]!;
    const period = parsePeriod(parts[1]);
    const cutoff = Date.now() - periodMs(period);
    const HARD_CAP = 10_000;
    if (kind === "users") {
      const users = Array.from(store.users.values());
      if (users.length > HARD_CAP) {
        await ctx.reply("Result too large; narrow the period.");
        return;
      }
      const header = "chat_id,timezone,quiet_start,quiet_end,summary_time,watch_count,last_activity_at";
      const rows = users.map((u) =>
        [
          u.telegramChatId,
          u.timezone ?? "",
          u.quietHoursStart,
          u.quietHoursEnd,
          u.summaryTime,
          store.listWatches(u.telegramChatId).length,
          "",
        ].map(csvCell).join(","),
      );
      const csv = [header, ...rows].join("\n");
      await ctx.replyWithDocument(new InputFile(Buffer.from(csv, "utf8"), `users_${periodToCsvSuffix(period)}.csv`));
      return;
    }
    // alerts
    const events = store.alertEvents.filter((e) => e.firedAt >= cutoff);
    if (events.length > HARD_CAP) {
      await ctx.reply("Result too large; narrow the period.");
      return;
    }
    const header = "fired_at,symbol,type,chat_id,payload_json";
    const rows = events.map((e) =>
      [
        new Date(e.firedAt).toISOString(),
        store.getToken(e.tokenId ?? "")?.symbol ?? "",
        e.type,
        e.userId,
        JSON.stringify(e.payload),
      ].map(csvCell).join(","),
    );
    const csv = [header, ...rows].join("\n");
    await ctx.replyWithDocument(new InputFile(Buffer.from(csv, "utf8"), `alerts_${periodToCsvSuffix(period)}.csv`));
  });
}
