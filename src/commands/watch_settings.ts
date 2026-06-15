// Per-watch alert settings (docs/details.md §5.7).
//
// "watch:settings:<token_id>" (from /list) opens a per-watch menu with
// current values + buttons to set/clear the absolute USD threshold, the
// percent threshold, and the percent timeframe. Text-input handlers (via
// the bot.ts text router) parse and validate the next message.

import { inlineButton, inlineKeyboard } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";
import type { Ctx } from "../bot.js";
import type { Store } from "../store.js";

function fmtThreshold(n: number | null): string {
  return n === null ? "not set" : `${n.toFixed(2)} USD`;
}

function renderWatchSettings(
  symbol: string,
  watch: { priceThresholdUsd: number | null; percentThreshold: number; percentTimeframeMinutes: number },
  tokenId: string,
): { text: string; reply_markup: ReturnType<typeof inlineKeyboard> } {
  const text = `${symbol} — alert settings\n` +
    `Absolute threshold: ${fmtThreshold(watch.priceThresholdUsd)}\n` +
    `Percent threshold: ${watch.percentThreshold.toFixed(1)}% over ${watch.percentTimeframeMinutes}m`;
  const reply_markup = inlineKeyboard([
    [inlineButton("Set absolute threshold", `watch:set_abs:${tokenId}`)],
    [inlineButton("Clear absolute threshold", `watch:clear_abs:${tokenId}`)],
    [inlineButton("Change percent threshold", `watch:set_pct:${tokenId}`)],
    [inlineButton("Change timeframe", `watch:set_time:${tokenId}`)],
    [inlineButton("Back to watchlist", "list:show")],
  ]);
  return { text, reply_markup };
}

export function registerWatchSettings(bot: Bot<Ctx>, store: Store): void {
  // ── watch:settings:<token_id> ────────────────────────────────────────
  bot.callbackQuery(/^watch:settings:[^:]+$/, async (ctx) => {
    const tokenId = ctx.match[0].slice("watch:settings:".length);
    const user = store.getOrCreateUser(ctx.from!.id);
    const watch = store.getWatch(user.telegramChatId, tokenId);
    const token = store.getToken(tokenId);
    if (!watch || !token) {
      await ctx.answerCallbackQuery({ text: "Watch not found" });
      return;
    }
    await ctx.answerCallbackQuery();
    const view = renderWatchSettings(token.symbol, watch, tokenId);
    try {
      await ctx.editMessageText(view.text, { reply_markup: view.reply_markup });
    } catch {
      await ctx.reply(view.text, { reply_markup: view.reply_markup });
    }
  });

  // ── set absolute threshold ───────────────────────────────────────────
  bot.callbackQuery(/^watch:set_abs:[^:]+$/, async (ctx) => {
    const tokenId = ctx.match[0].slice("watch:set_abs:".length);
    ctx.session.dialog = { kind: "watch_abs", tokenId };
    await ctx.answerCallbackQuery();
    await ctx.reply("Send the absolute USD price threshold (e.g. `1.05`). Send `none` to clear.");
  });

  // ── clear absolute threshold ─────────────────────────────────────────
  bot.callbackQuery(/^watch:clear_abs:[^:]+$/, async (ctx) => {
    const tokenId = ctx.match[0].slice("watch:clear_abs:".length);
    const user = store.getOrCreateUser(ctx.from!.id);
    const watch = store.getWatch(user.telegramChatId, tokenId);
    if (watch) {
      store.upsertWatch({ ...watch, priceThresholdUsd: null });
    }
    const token = store.getToken(tokenId);
    await ctx.answerCallbackQuery();
    if (watch && token) {
      const view = renderWatchSettings(token.symbol, watch, tokenId);
      try {
        await ctx.editMessageText(view.text, { reply_markup: view.reply_markup });
      } catch {
        await ctx.reply(view.text, { reply_markup: view.reply_markup });
      }
    }
  });

  // ── set percent threshold ────────────────────────────────────────────
  bot.callbackQuery(/^watch:set_pct:[^:]+$/, async (ctx) => {
    const tokenId = ctx.match[0].slice("watch:set_pct:".length);
    ctx.session.dialog = { kind: "watch_pct", tokenId };
    await ctx.answerCallbackQuery();
    await ctx.reply("Send the percent threshold (e.g. `2.5`).");
  });

  // ── set timeframe ────────────────────────────────────────────────────
  bot.callbackQuery(/^watch:set_time:[^:]+$/, async (ctx) => {
    const tokenId = ctx.match[0].slice("watch:set_time:".length);
    ctx.session.dialog = { kind: "watch_time", tokenId };
    await ctx.answerCallbackQuery();
    await ctx.reply("Send the timeframe in minutes (e.g. `60`).");
  });
}

/** Text-input handler for the per-watch settings dialogs. */
export async function handleWatchSettingsText(ctx: Ctx, store: Store): Promise<boolean> {
  const d = ctx.session.dialog;
  if (!d) return false;
  if (d.kind !== "watch_abs" && d.kind !== "watch_pct" && d.kind !== "watch_time") return false;
  const user = store.getOrCreateUser(ctx.from!.id);
  const watch = store.getWatch(user.telegramChatId, d.tokenId);
  if (!watch) {
    ctx.session.dialog = undefined;
    return false;
  }
  const text = ctx.message?.text?.trim();
  if (!text) return false;

  if (d.kind === "watch_abs") {
    if (text.toLowerCase() === "none" || text.toLowerCase() === "clear") {
      store.upsertWatch({ ...watch, priceThresholdUsd: null });
      ctx.session.dialog = undefined;
      await ctx.reply("Absolute threshold cleared.");
      return true;
    }
    const v = Number(text);
    if (!Number.isFinite(v) || v <= 0) {
      await ctx.reply("Send a positive number, or `none` to clear.");
      return true;
    }
    store.upsertWatch({ ...watch, priceThresholdUsd: v });
    ctx.session.dialog = undefined;
    await ctx.reply(`Absolute threshold set to ${v.toFixed(2)} USD.`);
    return true;
  }
  if (d.kind === "watch_pct") {
    const v = Number(text);
    if (!Number.isFinite(v) || v <= 0) {
      await ctx.reply("Send a positive number, e.g. `2.5`.");
      return true;
    }
    store.upsertWatch({ ...watch, percentThreshold: v });
    ctx.session.dialog = undefined;
    await ctx.reply(`Percent threshold set to ${v}%.`);
    return true;
  }
  if (d.kind === "watch_time") {
    const v = Number(text);
    if (!Number.isInteger(v) || v < 5 || v > 1440) {
      await ctx.reply("Send an integer between 5 and 1440 minutes.");
      return true;
    }
    store.upsertWatch({ ...watch, percentTimeframeMinutes: v });
    ctx.session.dialog = undefined;
    await ctx.reply(`Timeframe set to ${v} minutes.`);
    return true;
  }
  return false;
}
