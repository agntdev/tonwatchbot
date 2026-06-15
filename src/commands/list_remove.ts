// /list and /remove commands (docs/details.md §2.2 + §2.3, design §4.3).
//
// /list shows every enabled watch with its current price and 1h/24h
// percent change, plus per-token inline buttons (Price / Settings / Remove)
// and a footer row (Add token / Refresh).
//
// /remove shows the watchlist as inline "Remove" buttons. Tapping one opens
// a confirm dialog; tapping "Yes" deletes the Watch row.

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

function fmtPrice(n: number): string {
  return `${n.toFixed(2)} USD`;
}

function isStale(sampledAt: number, now = Date.now()): boolean {
  return now - sampledAt > 5 * 60_000;
}

function watchLine(symbol: string, quote: { priceUsd: number; change1h: number; change24h: number }, stale: boolean): string {
  const staleTag = stale ? "  (stale)" : "";
  return `• ${symbol} — ${fmtPrice(quote.priceUsd)}  ${fmtPct(quote.change1h)} (1h)  ${fmtPct(quote.change24h)} (24h)${staleTag}`;
}

function renderWatchlist(
  ctx: Ctx,
  store: Store,
): { text: string; reply_markup: ReturnType<typeof inlineKeyboard> } {
  const user = store.getOrCreateUser(ctx.from!.id);
  const watches = store.listWatches(user.telegramChatId).filter((w) => w.enabled);
  if (watches.length === 0) {
    return {
      text: "You're not watching any tokens yet. /add <contract> to start.",
      reply_markup: inlineKeyboard([[inlineButton("Add token", "add:another")]]),
    };
  }
  const lines: string[] = [`Your watchlist (${watches.length}):`];
  const rows: ReturnType<typeof inlineButton>[][] = [];
  const now = Date.now();
  for (const w of watches) {
    const token = store.getToken(w.tokenId);
    const sample = store.latestSample(w.tokenId);
    if (!token || !sample) {
      lines.push(`• ${token?.symbol ?? "???"} — (no price sample yet)`);
    } else {
      const oneH = store.sampleAtOrBefore(w.tokenId, sample.timestamp - 60 * 60_000);
      const oneD = store.sampleAtOrBefore(w.tokenId, sample.timestamp - 24 * 60 * 60_000);
      const q = buildQuote(w.tokenId, token.symbol, { priceUsd: sample.priceUsd, source: sample.source, sampledAt: sample.timestamp }, oneH?.priceUsd, oneD?.priceUsd);
      lines.push(watchLine(token.symbol, q, isStale(sample.timestamp, now)));
    }
    rows.push([
      inlineButton(`${token?.symbol ?? "?"}: Price`, `price:show:${w.tokenId}`),
      inlineButton(`${token?.symbol ?? "?"}: Settings`, `watch:settings:${w.tokenId}`),
      inlineButton(`${token?.symbol ?? "?"}: Remove`, `watch:remove:${w.tokenId}`),
    ]);
  }
  rows.push([inlineButton("Add token", "add:another"), inlineButton("Refresh", "list:refresh")]);
  return { text: lines.join("\n"), reply_markup: inlineKeyboard(rows) };
}

export function registerListRemove(bot: Bot<Ctx>, store: Store): void {
  // ── /list ─────────────────────────────────────────────────────────────
  bot.command("list", async (ctx) => {
    const view = renderWatchlist(ctx, store);
    await ctx.reply(view.text, { reply_markup: view.reply_markup });
  });

  // ── list:show (called from /start "Open watchlist" button + elsewhere)
  bot.callbackQuery("list:show", async (ctx) => {
    await ctx.answerCallbackQuery();
    const view = renderWatchlist(ctx, store);
    try {
      await ctx.editMessageText(view.text, { reply_markup: view.reply_markup });
    } catch {
      // No message to edit (e.g. user sent /start + tapped button on a fresh
      // message). Fall back to a new reply.
      await ctx.reply(view.text, { reply_markup: view.reply_markup });
    }
  });

  // ── list:refresh re-renders in place ──────────────────────────────────
  bot.callbackQuery("list:refresh", async (ctx) => {
    await ctx.answerCallbackQuery();
    const view = renderWatchlist(ctx, store);
    await ctx.editMessageText(view.text, { reply_markup: view.reply_markup });
  });

  // ── /remove ───────────────────────────────────────────────────────────
  bot.command("remove", async (ctx) => {
    const user = store.getOrCreateUser(ctx.from!.id);
    const watches = store.listWatches(user.telegramChatId).filter((w) => w.enabled);
    if (watches.length === 0) {
      await ctx.reply("Your watchlist is empty. /add <contract> to start.");
      return;
    }
    const rows = watches.map((w) => {
      const token = store.getToken(w.tokenId);
      return [inlineButton(`Remove ${token?.symbol ?? "?"}`, `watch:remove:${w.tokenId}`)];
    });
    rows.push([inlineButton("Cancel", "cancel")]);
    await ctx.reply("Tap to remove a token:", { reply_markup: inlineKeyboard(rows) });
  });

  // ── watch:remove:yes (commit) — registered FIRST so the more specific
  //    regex wins over the generic /watch:remove:/ one below ─────────────
  bot.callbackQuery(/^watch:remove:yes:(.+)$/, async (ctx) => {
    const tokenId = ctx.match[1]!;
    const user = store.getOrCreateUser(ctx.from!.id);
    const token = store.getToken(tokenId);
    store.deleteWatch(user.telegramChatId, tokenId);
    ctx.session.dialog = undefined;
    await ctx.answerCallbackQuery();
    const symbol = token?.symbol ?? "?";
    const remaining = store.listWatches(user.telegramChatId).filter((w) => w.enabled).length;
    const tail = remaining === 0 ? "\nYour watchlist is empty. /add <contract> to start." : "";
    await ctx.editMessageText(`Removed ${symbol}.${tail}`, {
      reply_markup: remaining === 0
        ? inlineKeyboard([[inlineButton("Add token", "add:another")]])
        : inlineKeyboard([[inlineButton("Open watchlist", "list:show")]]),
    });
  });

  // ── watch:remove: confirm prompt (generic; no :yes: or :no: suffix) ──
  bot.callbackQuery(/^watch:remove:[^:]+$/, async (ctx) => {
    const tokenId = ctx.match[0].slice("watch:remove:".length);
    const token = store.getToken(tokenId);
    if (!token) {
      await ctx.answerCallbackQuery({ text: "Token not found" });
      return;
    }
    ctx.session.dialog = { kind: "remove_confirm", tokenId };
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Remove ${token.symbol} from your watchlist?`, {
      reply_markup: inlineKeyboard([
        [inlineButton("Yes, remove", `watch:remove:yes:${tokenId}`), inlineButton("No", "watch:remove:no")],
      ]),
    });
  });

  // ── watch:remove:no (cancel) ──────────────────────────────────────────
  bot.callbackQuery("watch:remove:no", async (ctx) => {
    ctx.session.dialog = undefined;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Cancelled.");
  });
}
