// Bot assembly. The skeleton's update router: sessions, error boundary, the
// admin allowlist guard, and the F01-level command placeholders. Each
// follow-up feature task (F02–F11) modifies this file to add its command
// handler, callback namespace, or dialog state.

import { createBot, type BotContext } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";

import { adminOnly } from "./middleware.js";
import type { BotConfig } from "./config.js";
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

  // ── /start: create user row, reply welcome (F02 replaces with full
  //    onboarding flow that asks for timezone, etc.) ───────────────────
  bot.command("start", async (ctx) => {
    const user = store.getOrCreateUser(ctx.from!.id);
    if (user.timezone !== null) {
      // Existing user: redraw the watchlist (full implementation in F04).
      await ctx.reply("Welcome back.");
      return;
    }
    await ctx.reply(
      "Welcome to TonWatchBot! 👋\nFull onboarding flow lands in F02.",
    );
  });

  // ── /help: list of commands (kept short, F02-F11 enhance with detail) ─
  bot.command("help", async (ctx) => {
    await ctx.reply(
      "TonWatchBot — private TON/jetton price watching.\n" +
        "Commands: /start /add /remove /list /price /summary /settings",
    );
  });

  // ── fallback: unknown command → /help hint ──────────────────────────
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/") && !text.startsWith("/admin_")) {
      await ctx.reply("Unknown command. Try /help.");
      return;
    }
    // Non-command text outside an active dialog: ignore.
    if (!ctx.session.dialog) return;
    // Active dialogs are owned by their feature task; the F02+ flow
    // handlers will read this branch and process the input. Until then,
    // acknowledge to avoid silent drops during local dev.
    if (ctx.session.dialog) {
      await ctx.reply("Dialog input is not yet wired up — see F02-F11.");
    }
  });

  return bot;
}
