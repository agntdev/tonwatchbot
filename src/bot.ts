// Bot assembly. The skeleton's update router: sessions, error boundary, the
// admin allowlist guard, and the F01-level command placeholders. Each
// follow-up feature task (F02–F11) modifies this file to add its command
// handler, callback namespace, or dialog state.

import { confirmKeyboard, createBot, type BotContext } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";

import { adminOnly } from "./middleware.js";
import type { BotConfig } from "./config.js";
import { resolvedToToken, TokenNotFoundError, type PriceSource } from "./prices.js";
import type { Session } from "./session.js";
import type { Store } from "./store.js";

export type Ctx = BotContext<Session>;

export interface BuildBotDeps {
  store: Store;
  prices: PriceSource;
  cfg: BotConfig;
}

export function buildBot(token: string, deps: BuildBotDeps): Bot<Ctx> {
  const { store, prices, cfg } = deps;
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

  // ── /add <contract>: validate, resolve, confirm ────────────────────
  bot.command("add", async (ctx) => {
    store.getOrCreateUser(ctx.from!.id);
    const text = ctx.message!.text.trim();
    const contract = text.slice("/add".length).trim();

    if (!contract) {
      await ctx.reply(
        "Please provide a contract address.\nUsage: /add \\<contract\\_address\\>",
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    if (!/^[A-Za-z0-9_-]{40,60}$/.test(contract)) {
      await ctx.reply(
        "Invalid contract address format. A TON contract address should be 40-60 alphanumeric characters\\.",
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    try {
      const resolved = await prices.resolveToken(contract);
      ctx.session.dialog = { kind: "add_confirm", contract };

      const lines = [
        `<b>${resolved.name}</b> (${resolved.symbol})`,
        `Address: <code>${resolved.contractAddress}</code>`,
        `Decimals: ${resolved.decimals}`,
        `Price: $${resolved.priceUsd.toFixed(4)}`,
        `Source: ${resolved.source}`,
        "",
        "Add this token to your watchlist?",
      ].join("\n");

      await ctx.reply(lines, {
        parse_mode: "HTML",
        reply_markup: confirmKeyboard("add"),
      });
    } catch (err) {
      if (err instanceof TokenNotFoundError) {
        await ctx.reply(`Token not found: ${contract}`);
      } else {
        throw err;
      }
    }
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

  // ── callback queries: handle inline-keyboard confirmations ──────────
  bot.on("callback_query:data", async (ctx) => {
    const dialog = ctx.session.dialog;

    if (!dialog) {
      await ctx.answerCallbackQuery({ text: "This action has expired." });
      return;
    }

    if (dialog.kind === "add_confirm") {
      if (ctx.callbackQuery.data === "add:yes") {
        const contract = dialog.contract;
        try {
          const resolved = await prices.resolveToken(contract);
          const token = resolvedToToken(resolved);
          store.upsertToken(token);

          const userId = ctx.from!.id;
          const user = store.getOrCreateUser(userId);
          store.upsertWatch({
            userId,
            tokenId: token.contractAddress,
            enabled: true,
            priceThresholdUsd: null,
            percentThreshold: user.notificationPreferences.defaultPercentThreshold,
            percentTimeframeMinutes: user.notificationPreferences.defaultPercentTimeframeMinutes,
            lastAlertState: {},
            cooldownUntil: 0,
          });

          ctx.session.dialog = undefined;
          await ctx.answerCallbackQuery({ text: "Token added!" });
          await ctx.editMessageReplyMarkup();
          await ctx.reply(
            `*${resolved.name}* \\(${resolved.symbol}\\) added to your watchlist\\.`,
            { parse_mode: "MarkdownV2" },
          );
          return;
        } catch {
          ctx.session.dialog = undefined;
          await ctx.answerCallbackQuery({ text: "Failed to add token." });
          await ctx.editMessageReplyMarkup();
          await ctx.reply("Failed to resolve the token. Please try again.");
          return;
        }
      }

      if (ctx.callbackQuery.data === "add:no") {
        ctx.session.dialog = undefined;
        await ctx.answerCallbackQuery({ text: "Canceled." });
        await ctx.editMessageReplyMarkup();
        await ctx.reply("Token not added\\.");
        return;
      }
    }

    await ctx.answerCallbackQuery();
  });

  return bot;
}
