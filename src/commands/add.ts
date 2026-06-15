// /add command + confirmation dialog (docs/details.md §2.1, design §4.2).
//
// Validates the contract address, resolves it via the price source, and
// presents a confirmation card with three inline buttons. "Add with
// defaults" inserts the Watch row using the user's default percent
// threshold + timeframe. "Customize" opens the per-watch settings dialog
// (handled in F07). "Cancel" clears the dialog.

import { inlineButton, inlineKeyboard } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";
import type { Ctx } from "../bot.js";
import { TokenNotFoundError, type PriceSource, resolvedToToken } from "../prices.js";
import type { Store } from "../store.js";

/** Loose TON contract-address shape check. 48 chars, base64url alphabet,
 *  optional EQ/UQ prefix. The full CRC is verified by the resolver. */
export function isPlausibleContractAddress(s: string): boolean {
  if (s.length < 40 || s.length > 60) return false;
  return /^[A-Za-z0-9_-]+$/.test(s);
}

function confirmKeyboard(contract: string): ReturnType<typeof inlineKeyboard> {
  return inlineKeyboard([
    [inlineButton("Add with defaults", `add:confirm:${contract}`)],
    [inlineButton("Customize alerts", `add:customize:${contract}`)],
    [inlineButton("Cancel", "cancel")],
  ]);
}

function formatResolutionCard(symbol: string, name: string, price: number, source: string, sampledAt: number): string {
  const utc = new Date(sampledAt).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return `✅ Resolved: ${symbol} (${name})\nCurrent price: ${price.toFixed(2)} USD\nSource: ${source} (${utc})`;
}

export function registerAdd(bot: Bot<Ctx>, store: Store, prices: PriceSource): void {
  // ── /add <contract> ──────────────────────────────────────────────────
  bot.command("add", async (ctx) => {
    const arg = ctx.message?.text?.replace(/^\/add(@\w+)?\s*/, "").trim() ?? "";
    if (!arg) {
      await ctx.reply("Usage: /add <contract>");
      return;
    }
    if (!isPlausibleContractAddress(arg)) {
      await ctx.reply("Invalid address format.");
      return;
    }
    try {
      const resolved = await prices.resolveToken(arg);
      store.upsertToken(resolvedToToken(resolved));
      ctx.session.dialog = { kind: "add_confirm", contract: resolved.contractAddress };
      await ctx.reply(formatResolutionCard(resolved.symbol, resolved.name, resolved.priceUsd, resolved.source, resolved.sampledAt), {
        reply_markup: confirmKeyboard(resolved.contractAddress),
      });
    } catch (err) {
      if (err instanceof TokenNotFoundError) {
        await ctx.reply("Could not find that contract. Check the address and try again.");
      } else {
        await ctx.reply("Price source unavailable. Try again in a minute.");
      }
    }
  });

  // ── confirm add: insert Watch row with user defaults ─────────────────
  bot.callbackQuery(/^add:confirm:(.+)$/, async (ctx) => {
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
    ctx.session.dialog = undefined;
    await ctx.answerCallbackQuery();
    await ctx.reply(`Added ${token.symbol} to your watchlist.`, {
      reply_markup: inlineKeyboard([
        [inlineButton("Open watchlist", "list:show")],
        [inlineButton("Add another", "add:another")],
      ]),
    });
  });

  // ── customize: hands off to F07 (per-watch settings) ─────────────────
  bot.callbackQuery(/^add:customize:(.+)$/, async (ctx) => {
    const contract = ctx.match[1]!;
    const user = store.getOrCreateUser(ctx.from!.id);
    const token = store.getToken(contract);
    if (!token) {
      await ctx.answerCallbackQuery({ text: "Token missing" });
      return;
    }
    // Pre-create the watch so F07 can edit it; F07 may extend the dialog.
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
    ctx.session.dialog = { kind: "watch_pct", tokenId: token.contractAddress };
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Customize ${token.symbol}. Send the percent threshold (e.g. \`2.5\`).`,
    );
  });

  // ── add another: re-ask for /add usage ───────────────────────────────
  bot.callbackQuery("add:another", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Send a contract address: `/add <contract>`");
    ctx.session.dialog = { kind: "add_confirm", contract: "" };
  });
}
