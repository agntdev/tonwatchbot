// Per-watch alert settings (F07). Implements the watch:settings sub-menu with
// dialogs for absolute threshold, percent threshold, and timeframe, as well as
// the text-input chaining for the add:customize flow.
//
// docs/details.md §5.7, design §4.3.

import { inlineButton, inlineKeyboard } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";
import type { Ctx } from "../bot.js";
import type { Store } from "../store.js";

function settingsKeyboard(tokenId: string): ReturnType<typeof inlineKeyboard> {
  return inlineKeyboard([
    [inlineButton("Set price threshold", `watch:set_abs:${tokenId}`)],
    [inlineButton("Clear price threshold", `watch:clear_abs:${tokenId}`)],
    [inlineButton("Set % threshold", `watch:set_pct:${tokenId}`)],
    [inlineButton("Set timeframe", `watch:set_time:${tokenId}`)],
    [inlineButton("Back to watchlist", "list:show")],
  ]);
}

export function registerWatchSettings(bot: Bot<Ctx>, store: Store): void {
  bot.callbackQuery(/^watch:settings:(.+)$/, async (ctx) => {
    const tokenId = ctx.match[1]!;
    const user = store.getOrCreateUser(ctx.from!.id);
    const watch = store.getWatch(user.telegramChatId, tokenId);
    const token = store.getToken(tokenId);
    if (!watch || !token) {
      await ctx.answerCallbackQuery({ text: "Watch/token not found" });
      return;
    }
    const absLine = watch.priceThresholdUsd !== null
      ? `Price threshold: ${watch.priceThresholdUsd} USD`
      : "Price threshold: not set";
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `${token.symbol} alert settings:\n${absLine}\n% threshold: ${watch.percentThreshold}%\nTimeframe: ${watch.percentTimeframeMinutes} min`,
      { reply_markup: settingsKeyboard(tokenId) },
    );
  });

  bot.callbackQuery(/^watch:set_abs:(.+)$/, async (ctx) => {
    const tokenId = ctx.match[1]!;
    const token = store.getToken(tokenId);
    if (!token) {
      await ctx.answerCallbackQuery({ text: "Token not found" });
      return;
    }
    ctx.session.dialog = { kind: "watch_abs", tokenId };
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Set price threshold for ${token.symbol}. Send a positive USD amount (e.g. \`1.50\`).`,
    );
  });

  bot.callbackQuery(/^watch:clear_abs:(.+)$/, async (ctx) => {
    const tokenId = ctx.match[1]!;
    const user = store.getOrCreateUser(ctx.from!.id);
    const watch = store.getWatch(user.telegramChatId, tokenId);
    const token = store.getToken(tokenId);
    if (!watch || !token) {
      await ctx.answerCallbackQuery({ text: "Watch/token not found" });
      return;
    }
    watch.priceThresholdUsd = null;
    const absLine = "Price threshold: not set";
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `${token.symbol} alert settings:\n${absLine}\n% threshold: ${watch.percentThreshold}%\nTimeframe: ${watch.percentTimeframeMinutes} min`,
      { reply_markup: settingsKeyboard(tokenId) },
    );
  });

  bot.callbackQuery(/^watch:set_pct:(.+)$/, async (ctx) => {
    const tokenId = ctx.match[1]!;
    const token = store.getToken(tokenId);
    if (!token) {
      await ctx.answerCallbackQuery({ text: "Token not found" });
      return;
    }
    ctx.session.dialog = { kind: "watch_pct", tokenId };
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Set % threshold for ${token.symbol}. Send a positive number (e.g. \`2.5\`).`,
    );
  });

  bot.callbackQuery(/^watch:set_time:(.+)$/, async (ctx) => {
    const tokenId = ctx.match[1]!;
    const token = store.getToken(tokenId);
    if (!token) {
      await ctx.answerCallbackQuery({ text: "Token not found" });
      return;
    }
    ctx.session.dialog = { kind: "watch_time", tokenId };
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Set timeframe for ${token.symbol}. Send minutes (5–1440, e.g. \`60\`).`,
    );
  });
}

function showSettings(ctx: Ctx, store: Store, tokenId: string): Promise<unknown> {
  const user = store.getOrCreateUser(ctx.from!.id);
  const watch = store.getWatch(user.telegramChatId, tokenId);
  const token = store.getToken(tokenId);
  if (!watch || !token) {
    return ctx.reply("Settings unavailable.");
  }
  const absLine = watch.priceThresholdUsd !== null
    ? `Price threshold: ${watch.priceThresholdUsd} USD`
    : "Price threshold: not set";
  ctx.session.dialog = undefined;
  return ctx.reply(
    `${token.symbol} alert settings:\n${absLine}\n% threshold: ${watch.percentThreshold}%\nTimeframe: ${watch.percentTimeframeMinutes} min`,
    { reply_markup: settingsKeyboard(tokenId) },
  );
}

function showCompletion(ctx: Ctx, store: Store, tokenId: string): Promise<unknown> {
  const token = store.getToken(tokenId);
  ctx.session.dialog = undefined;
  return ctx.reply(
    `Alert settings saved for ${token?.symbol ?? "?"}.`,
    { reply_markup: inlineKeyboard([[inlineButton("Open watchlist", "list:show")]]) },
  );
}

export async function handleWatchSettingsText(ctx: Ctx, store: Store): Promise<boolean> {
  const d = ctx.session.dialog;
  if (!d) return false;
  const text = ctx.message?.text?.trim();
  if (!text) return false;

  if (d.kind === "watch_pct") {
    const v = Number(text);
    if (!Number.isFinite(v) || v <= 0) {
      await ctx.reply("Send a positive number, e.g. `2.5`.");
      return true;
    }
    const user = store.getOrCreateUser(ctx.from!.id);
    const watch = store.getWatch(user.telegramChatId, d.tokenId);
    if (watch) watch.percentThreshold = v;
    if (d.chain) {
      ctx.session.dialog = { kind: "watch_abs", tokenId: d.tokenId, chain: true };
      const token = store.getToken(d.tokenId);
      await ctx.reply(`% threshold set. Now send a price threshold in USD for ${token?.symbol ?? "?"} (e.g. \`1.50\`).`);
    } else {
      await showSettings(ctx, store, d.tokenId);
    }
    return true;
  }

  if (d.kind === "watch_abs") {
    const v = Number(text);
    if (!Number.isFinite(v) || v <= 0) {
      await ctx.reply("Send a positive USD amount, e.g. `1.50`.");
      return true;
    }
    const user = store.getOrCreateUser(ctx.from!.id);
    const watch = store.getWatch(user.telegramChatId, d.tokenId);
    if (watch) watch.priceThresholdUsd = v;
    if (d.chain) {
      ctx.session.dialog = { kind: "watch_time", tokenId: d.tokenId, chain: true };
      const token = store.getToken(d.tokenId);
      await ctx.reply(`Price threshold set. Now send the timeframe in minutes for ${token?.symbol ?? "?"} (5–1440, e.g. \`60\`).`);
    } else {
      await showSettings(ctx, store, d.tokenId);
    }
    return true;
  }

  if (d.kind === "watch_time") {
    const v = Number(text);
    if (!Number.isInteger(v) || v < 5 || v > 1440) {
      await ctx.reply("Send an integer between 5 and 1440 minutes.");
      return true;
    }
    const user = store.getOrCreateUser(ctx.from!.id);
    const watch = store.getWatch(user.telegramChatId, d.tokenId);
    if (watch) watch.percentTimeframeMinutes = v;
    if (d.chain) {
      await showCompletion(ctx, store, d.tokenId);
    } else {
      await showSettings(ctx, store, d.tokenId);
    }
    return true;
  }

  return false;
}