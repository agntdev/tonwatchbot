// /price command (docs/details.md §3.1).
//
// Resolves a contract address and shows the current USD price with 1h/24h
// change. If the user already has a watch on the token, the
// "Add to watchlist" button is replaced with "Already in your watchlist".

import { inlineButton, inlineKeyboard } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";
import type { Ctx } from "../bot.js";
import { TokenNotFoundError, type PriceSource, buildQuote, resolvedToToken } from "../prices.js";
import { isPlausibleContractAddress } from "./add.js";
import type { Store } from "../store.js";

function fmtPct(p: number): string {
  if (!Number.isFinite(p)) return "0.0%";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(1)}%`;
}

function renderPriceCard(
  symbol: string,
  quote: { priceUsd: number; change1h: number; change24h: number; source: string; sampledAt: number },
  contract: string,
  alreadyWatched: boolean,
): { text: string; reply_markup: ReturnType<typeof inlineKeyboard> } {
  const utc = new Date(quote.sampledAt).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const text = `${symbol} — ${quote.priceUsd.toFixed(2)} USD\n1h ${fmtPct(quote.change1h)}  ·  24h ${fmtPct(quote.change24h)}\nSource: ${quote.source} · ${utc}`;
  const button = alreadyWatched
    ? inlineButton("Already in your watchlist", "noop")
    : inlineButton("Add to watchlist", `add:from_price:${contract}`);
  return { text, reply_markup: inlineKeyboard([[button]]) };
}

export function registerPrice(bot: Bot<Ctx>, store: Store, prices: PriceSource): void {
  // ── /price <contract> ────────────────────────────────────────────────
  bot.command("price", async (ctx) => {
    const arg = ctx.message?.text?.replace(/^\/price(@\w+)?\s*/, "").trim() ?? "";
    if (!arg) {
      await ctx.reply("Usage: /price <contract>");
      return;
    }
    if (!isPlausibleContractAddress(arg)) {
      await ctx.reply("Invalid address format.");
      return;
    }
    try {
      const resolved = await prices.resolveToken(arg);
      store.upsertToken(resolvedToToken(resolved));
      const oneH = store.sampleAtOrBefore(resolved.contractAddress, resolved.sampledAt - 60 * 60_000);
      const oneD = store.sampleAtOrBefore(resolved.contractAddress, resolved.sampledAt - 24 * 60 * 60_000);
      const quote = buildQuote(
        resolved.contractAddress,
        resolved.symbol,
        { priceUsd: resolved.priceUsd, source: resolved.source, sampledAt: resolved.sampledAt },
        oneH?.priceUsd,
        oneD?.priceUsd,
      );
      const user = store.getOrCreateUser(ctx.from!.id);
      const watched = !!store.getWatch(user.telegramChatId, resolved.contractAddress);
      const card = renderPriceCard(resolved.symbol, quote, resolved.contractAddress, watched);
      await ctx.reply(card.text, { reply_markup: card.reply_markup });
    } catch (err) {
      if (err instanceof TokenNotFoundError) {
        await ctx.reply("Could not find that contract.");
      } else {
        await ctx.reply("Price source unavailable. Try again in a minute.");
      }
    }
  });

  // ── price:show:<token_id> (button tap from /list) ────────────────────
  bot.callbackQuery(/^price:show:(.+)$/, async (ctx) => {
    const tokenId = ctx.match[1]!;
    const user = store.getOrCreateUser(ctx.from!.id);
    const token = store.getToken(tokenId);
    if (!token) {
      await ctx.answerCallbackQuery({ text: "Token not found" });
      return;
    }
    const sample = store.latestSample(token.contractAddress);
    if (!sample) {
      await ctx.answerCallbackQuery();
      await ctx.reply(`${token.symbol} — (no price sample yet)`);
      return;
    }
    const oneH = store.sampleAtOrBefore(token.contractAddress, sample.timestamp - 60 * 60_000);
    const oneD = store.sampleAtOrBefore(token.contractAddress, sample.timestamp - 24 * 60 * 60_000);
    const quote = buildQuote(
      token.contractAddress,
      token.symbol,
      { priceUsd: sample.priceUsd, source: sample.source, sampledAt: sample.timestamp },
      oneH?.priceUsd,
      oneD?.priceUsd,
    );
    const watched = !!store.getWatch(user.telegramChatId, token.contractAddress);
    const card = renderPriceCard(token.symbol, quote, token.contractAddress, watched);
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(card.text, { reply_markup: card.reply_markup });
    } catch {
      await ctx.reply(card.text, { reply_markup: card.reply_markup });
    }
  });

  // ── noop button (for "Already in your watchlist") ────────────────────
  bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Already in your watchlist" });
  });
}
