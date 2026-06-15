// Bot assembly. The skeleton's update router: sessions, error boundary, the
// admin allowlist guard, and the F01-level command placeholders. Each
// follow-up feature task (F02–F11) modifies this file to add its command
// handler, callback namespace, or dialog state.

import { createBot, type BotContext } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";

import { registerAdd } from "./commands/add.js";
import { registerAdmin } from "./commands/admin.js";
import { registerAlertDelivery } from "./commands/alerts.js";
import { registerListRemove } from "./commands/list_remove.js";
import { registerOutage } from "./commands/outage.js";
import { registerPrice } from "./commands/price.js";
import { handleSettingsText, registerSettings } from "./commands/settings.js";
import { registerStart, handleOnboardingText } from "./commands/start.js";
import { handleWatchSettingsText, registerWatchSettings } from "./commands/watch_settings.js";
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

  // ── feature installers ──────────────────────────────────────────────
  // Each feature task (F02–F11) adds its own registerXxx() call here.
  registerStart(bot, store);
  registerAdd(bot, store, deps.prices);
  registerListRemove(bot, store);
  registerPrice(bot, store, deps.prices);
  registerSettings(bot, store);
  registerAdmin(bot, store);
  registerWatchSettings(bot, store);
  registerAlertDelivery(bot, store);
  registerOutage(bot, store);

  // ── /help: list of commands (kept short, F02-F11 enhance with detail) ─
  bot.command("help", async (ctx) => {
    await ctx.reply(
      "TonWatchBot — private TON/jetton price watching.\n" +
        "Commands: /start /add /remove /list /price /summary /settings",
    );
  });

  // ── text router: dialogs first, then unknown-command fallback ───────
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/") && !text.startsWith("/admin_")) {
      // Unknown command — only if no other command handler matched
      // (grammY's command router runs first; if we get here on a /-prefix
      // text, no command handler claimed it).
      await ctx.reply("Unknown command. Try /help.");
      return;
    }
    if (await handleOnboardingText(ctx, store)) return;
    if (await handleSettingsText(ctx, store)) return;
    if (await handleWatchSettingsText(ctx, store)) return;
    // Other dialogs (settings, add_confirm, etc.) are handled in their
    // own feature files. Until those land, we ignore stray non-command
    // text silently to keep the bot non-spammy.
  });

  // ── foreign callback: claim every unhandled callback_query ──────────
  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Not yours", show_alert: true });
  });

  return bot;
}
