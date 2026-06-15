// Price-alert delivery UX (docs/details.md §4.6, §6.1, design §4.6).
//
// The alert engine in src/alerts.ts is the EVALUATION engine (decides when
// to enqueue an alert). This file owns the DELIVERY UX: the snooze button,
// the "View token" button (already in F05), the on-demand /summary
// command, and a small helper that lets the harness / admin replay a
// sample alert without waiting 60s for the poller.
//
// The alert engine + outbox drainer run in the production main.ts; the
// handler callbacks here wire the user-facing buttons to side effects.

import { inlineButton, inlineKeyboard } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";
import type { Ctx } from "../bot.js";
import { buildQuote } from "../prices.js";
import type { Store } from "../store.js";

function fmtPct(p: number): string {
  if (!Number.isFinite(p)) return "0.0%";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(1)}%`;
}

function renderSummaryCard(watches: { symbol: string; priceUsd: number; change1h: number; change24h: number }[], source: string, sampledAt: number): string {
  if (watches.length === 0) {
    return "Your watchlist is empty. /add <contract> to start.";
  }
  const utc = new Date(sampledAt).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const body = watches
    .map((w) => `• ${w.symbol} — ${w.priceUsd.toFixed(2)} USD  ${fmtPct(w.change1h)} (1h)  ${fmtPct(w.change24h)} (24h)`)
    .join("\n");
  return `📊 Summary\n${body}\nSource: ${source} · ${utc}`;
}

function buildUserSummaryRows(userId: number, store: Store): { symbol: string; priceUsd: number; change1h: number; change24h: number }[] {
  const watches = store.listWatches(userId);
  const rows: { symbol: string; priceUsd: number; change1h: number; change24h: number }[] = [];
  for (const w of watches) {
    const t = store.getToken(w.tokenId);
    const s = store.latestSample(w.tokenId);
    if (!t || !s) continue;
    const oneH = store.sampleAtOrBefore(w.tokenId, s.timestamp - 60 * 60_000);
    const oneD = store.sampleAtOrBefore(w.tokenId, s.timestamp - 24 * 60 * 60_000);
    rows.push({
      symbol: t.symbol,
      priceUsd: s.priceUsd,
      change1h: oneH ? ((s.priceUsd - oneH.priceUsd) / oneH.priceUsd) * 100 : 0,
      change24h: oneD ? ((s.priceUsd - oneD.priceUsd) / oneD.priceUsd) * 100 : 0,
    });
  }
  return rows;
}

export function registerAlertDelivery(bot: Bot<Ctx>, store: Store): void {
  // ── /summary (on-demand) ─────────────────────────────────────────────
  bot.command("summary", async (ctx) => {
    const user = store.getOrCreateUser(ctx.from!.id);
    const rows = buildUserSummaryRows(user.telegramChatId, store);
    const now = Date.now();
    const text = renderSummaryCard(rows, "on-demand", now);
    await ctx.reply(text);
  });

  // ── snooze button on alert messages ──────────────────────────────────
  bot.callbackQuery(/^alert:snooze:(\d+)$/, async (ctx) => {
    const minutes = Number(ctx.match[1]);
    const user = store.getOrCreateUser(ctx.from!.id);
    // Snooze applies to every watch the user has for now (the alert message
    // doesn't carry the specific token id; for the foundation this is a
    // reasonable scope. F08 refines if needed).
    const until = Date.now() + minutes * 60_000;
    let count = 0;
    for (const w of store.listWatches(user.telegramChatId)) {
      if (w.cooldownUntil < until) {
        store.upsertWatch({ ...w, cooldownUntil: until });
        count++;
      }
    }
    await ctx.answerCallbackQuery({ text: `Snoozed ${count} watch(es) for ${minutes}m` });
  });

  // ── add:from_price:<contract> (from /price "Add to watchlist" button) ─
  bot.callbackQuery(/^add:from_price:(.+)$/, async (ctx) => {
    const contract = ctx.match[1]!;
    const user = store.getOrCreateUser(ctx.from!.id);
    const token = store.getToken(contract);
    if (!token) {
      await ctx.answerCallbackQuery({ text: "Token missing" });
      return;
    }
    store.upsertWatch({
      userId: user.telegramChatId,
      tokenId: token.contractAddress,
      enabled: true,
      priceThresholdUsd: null,
      percentThreshold: user.notificationPreferences.defaultPercentThreshold,
      percentTimeframeMinutes: user.notificationPreferences.defaultPercentTimeframeMinutes,
      lastAlertState: {},
      cooldownUntil: 0,
    });
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({
      reply_markup: inlineKeyboard([[inlineButton("Already in your watchlist", "noop")]]),
    });
  });
}
