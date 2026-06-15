// Source-outage admin alerts (docs/details.md §7.5).
//
// The price poller tracks per-source last-success timestamps. The outage
// detector (in this file) checks every alert-engine tick whether any
// source has not succeeded within `sourceOutageMinutes`. If so AND there
// is no open AdminRecord for that source, the detector inserts one and
// queues an outbox message to every admin chat. The message carries an
// "Acknowledge" button bound to `admin:ack:<record_id>`.

import { inlineButton, inlineKeyboard } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";
import type { Ctx } from "../bot.js";
import type { BotConfig } from "../config.js";
import type { PricePoller } from "../poller.js";
import type { Store } from "../store.js";

/** Run the outage check. Returns the number of NEW admin records created. */
export function detectOutages(
  poller: PricePoller,
  store: Store,
  cfg: BotConfig,
  now = Date.now(),
): number {
  const thresholdMs = cfg.sourceOutageMinutes * 60_000;
  let created = 0;
  for (const { source, lastSuccess } of poller.sourceStatus()) {
    const ageMs = lastSuccess === undefined ? Number.POSITIVE_INFINITY : now - lastSuccess;
    if (ageMs < thresholdMs) continue;
    if (store.findOpenAdminRecordBySource(source)) continue;
    const rec = store.createAdminRecord({
      tokenId: null,
      kind: "source_outage",
      source,
      alertCount: 1,
      lastAlertTime: now,
      open: true,
    });
    const minutes = lastSuccess === undefined ? "since start" : `${Math.floor(ageMs / 60_000)}m`;
    const text = `⚠️ ${source} unreachable for ${minutes}. Last success: ${
      lastSuccess === undefined ? "never" : new Date(lastSuccess).toISOString().slice(0, 16).replace("T", " ") + " UTC"
    }.`;
    for (const chatId of cfg.adminChatIds) {
      store.enqueueOutbox({
        userId: chatId,
        chatId,
        kind: "source_outage",
        payload: { message: text, adminRecordId: rec.id },
        dueAt: now,
      });
    }
    created++;
  }
  return created;
}

export function registerOutage(bot: Bot<Ctx>, store: Store): void {
  // ── admin:ack:<record_id> ────────────────────────────────────────────
  bot.callbackQuery(/^admin:ack:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const rec = store.getAdminRecord(id);
    if (!rec) {
      await ctx.answerCallbackQuery({ text: "Already handled" });
      return;
    }
    store.ackAdminRecord(id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Acknowledged.", {
      reply_markup: inlineKeyboard([[inlineButton("Acknowledged", "noop")]]),
    });
  });
}
