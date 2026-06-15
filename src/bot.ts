// Bot assembly. The skeleton's update router: sessions, error boundary, the
// admin allowlist guard, and the F01-level command placeholders. Each
// follow-up feature task (F02–F11) modifies this file to add its command
// handler, callback namespace, or dialog state.

import { createBot, type BotContext, inlineButton, inlineKeyboard } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";

import { adminOnly } from "./middleware.js";
import { isValidTimezone, type BotConfig } from "./config.js";
import type { PriceSource } from "./prices.js";
import type { Session } from "./session.js";
import type { Store } from "./store.js";

export type Ctx = BotContext<Session>;

export interface BuildBotDeps {
  store: Store;
  prices: PriceSource;
  cfg: BotConfig;
}

export function buildBot(token: string, deps: BuildBotDeps): Bot<Ctx> {
  const { store, cfg } = deps;
  const bot = createBot<Session>(token, { initial: () => ({}) });

  // ── error boundary: never crash the polling loop ─────────────────────
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error("[tonwatchbot] handler error:", err);
      try {
        await ctx.reply("Something went wrong. Try again.");
      } catch {
        /* nothing else we can do */
      }
    }
  });

  // ── admin guard for /admin_* ─────────────────────────────────────────
  bot.use(adminOnly(cfg));

  // ── /start: full onboarding flow ───────────────────────────────────
  bot.command("start", async (ctx) => {
    const user = store.getOrCreateUser(ctx.from!.id);
    if (user.timezone !== null) {
      // Existing user: redraw the watchlist (full implementation in F04).
      await ctx.reply("Welcome back.");
      return;
    }
    ctx.session.dialog = { kind: "onboarding", step: "tz" };
    await ctx.reply(
      "Welcome to TonWatchBot! 👋\n" +
        "To send alerts at the right time, pick your timezone:",
      {
        reply_markup: inlineKeyboard([
          [
            inlineButton("Europe/London", "tz:select:Europe/London"),
            inlineButton("Europe/Berlin", "tz:select:Europe/Berlin"),
          ],
          [
            inlineButton("America/New_York", "tz:select:America/New_York"),
            inlineButton("America/Los_Angeles", "tz:select:America/Los_Angeles"),
          ],
          [
            inlineButton("Asia/Singapore", "tz:select:Asia/Singapore"),
            inlineButton("Asia/Tokyo", "tz:select:Asia/Tokyo"),
          ],
          [
            inlineButton("Enter manually…", "tz:manual"),
            inlineButton("Cancel", "cancel"),
          ],
        ]),
      },
    );
  });

  // ── /help: list of commands (kept short, F02-F11 enhance with detail) ─
  bot.command("help", async (ctx) => {
    await ctx.reply(
      "TonWatchBot — private TON/jetton price watching.\n" +
        "Commands: /start /add /remove /list /price /summary /settings",
    );
  });

  // ── F02 onboarding: timezone selection callback ──────────────────────
  bot.callbackQuery(/^tz:select:(.+)$/, async (ctx) => {
    const dialog = ctx.session.dialog;
    if (!dialog || dialog.kind !== "onboarding" || dialog.step !== "tz") {
      await ctx.answerCallbackQuery({ text: "Not yours", show_alert: true });
      return;
    }
    const tz = ctx.match[1]!;
    if (!isValidTimezone(tz)) {
      await ctx.answerCallbackQuery({ text: "Invalid timezone", show_alert: true });
      return;
    }
    store.updateUser(ctx.from!.id, { timezone: tz });
    ctx.session.dialog = { kind: "onboarding", step: "defaults" };
    await ctx.editMessageText(
      `Timezone set: ${tz}.\n` +
        "Quiet hours default to 23:00–07:00.\n" +
        "Daily summary at 08:00.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Keep defaults", "defaults:keep")],
        ]),
      },
    );
  });

  // ── F02 onboarding: manual timezone entry trigger ───────────────────
  bot.callbackQuery("tz:manual", async (ctx) => {
    const dialog = ctx.session.dialog;
    if (!dialog || dialog.kind !== "onboarding" || dialog.step !== "tz") {
      await ctx.answerCallbackQuery({ text: "Not yours", show_alert: true });
      return;
    }
    ctx.session.dialog = { kind: "onboarding", step: "tz_manual" };
    await ctx.editMessageText(
      "Send your IANA timezone (e.g. Europe/London):",
      { reply_markup: inlineKeyboard([[inlineButton("Cancel", "cancel")]]) },
    );
  });

  // ── F02 onboarding: keep defaults confirmation ──────────────────────
  bot.callbackQuery("defaults:keep", async (ctx) => {
    const dialog = ctx.session.dialog;
    if (!dialog || dialog.kind !== "onboarding" || dialog.step !== "defaults") {
      await ctx.answerCallbackQuery({ text: "Not yours", show_alert: true });
      return;
    }
    ctx.session.dialog = undefined;
    await ctx.editMessageText(
      "All set. Try /add <contract> to watch a token, or /help for the full command list.",
    );
  });

  // ── global cancel: clear any active dialog ──────────────────────────
  bot.callbackQuery("cancel", async (ctx) => {
    if (!ctx.session.dialog) {
      await ctx.answerCallbackQuery({ text: "Nothing to cancel", show_alert: true });
      return;
    }
    ctx.session.dialog = undefined;
    await ctx.editMessageText("Cancelled.").catch(() => {
      // message not editable (e.g. too old): try sending a new message
    });
  });

  // ── fallback: unknown command → /help hint ──────────────────────────
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/") && !text.startsWith("/admin_")) {
      await ctx.reply("Unknown command. Try /help.");
      return;
    }
    const dialog = ctx.session.dialog;
    if (!dialog) return;

    // F02 — onboarding: manual timezone text input
    if (dialog.kind === "onboarding" && dialog.step === "tz_manual") {
      const tz = text.trim();
      if (!isValidTimezone(tz)) {
        await ctx.reply("Unknown timezone, try again.");
        return;
      }
      store.updateUser(ctx.from!.id, { timezone: tz });
      ctx.session.dialog = undefined;
      await ctx.reply(
        `Timezone set: ${tz}.\n` +
          "All set. Try /add <contract> to watch a token, or /help for the full command list.",
      );
      return;
    }

    // Other active dialogs not yet wired up (F03–F11).
    await ctx.reply("Dialog input is not yet wired up — see F03-F11.");
  });

  return bot;
}
