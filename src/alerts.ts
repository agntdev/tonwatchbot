// Alert engine. Two parts:
//   1. `evaluateAlerts(store, cfg, tokenId)` — pure function. Called by the
//      price poller after every sample. For each enabled watch on the
//      token, decides whether to enqueue a price or percent alert. Applies
//      cooldown and hysteresis. Quiet hours defer the message (sets
//      `dueAt` to the end-of-quiet instant).
//   2. `AlertEngine.drain()` — bot-process owner. Ticks every
//      `alertTickMs`, pulls due rows from the outbox, sends them via
//      `bot.api.sendMessage`, and records the AlertEvent.
//
// Hysteresis: once a percent threshold has fired, the price must move
// OUT of the band by `hysteresisBand` (default 0.5%) before another alert
// can fire on the same watch.

import type { Bot } from "grammy";
import { inQuietHours, quietHoursEndAt, type BotConfig } from "./config.js";
import type { OutboxRow, PriceSample, User, Watch } from "./types.js";
import { Store } from "./store.js";
import type { Ctx } from "./bot.js";

const ALERT_KIND_PRICE = "price" as const;
const ALERT_KIND_PERCENT = "percent" as const;
const ALERT_KIND_SUMMARY = "summary" as const;
const ALERT_KIND_OUTAGE = "source_outage" as const;

/** Pure: evaluate alerts for a token after a new price sample. Called by
 *  the price poller. */
export function evaluateAlerts(store: Store, cfg: BotConfig, tokenId: string, now = Date.now()): void {
  const token = store.getToken(tokenId);
  if (!token) return;
  const sample = store.latestSample(tokenId);
  if (!sample) return;
  for (const watch of store.listEnabledWatchesForToken(tokenId)) {
    if (watch.cooldownUntil > now) continue;
    const user = store.users.get(watch.userId);
    if (!user) continue;
    if (user.notificationPreferences.alertTypes.length === 0) continue;

    const priceFire = shouldFirePrice(watch, sample.priceUsd);
    const pctFire = shouldFirePercent(store, watch, sample, cfg.hysteresisBand);

    if (!priceFire.fired && !pctFire.fired) continue;

    const kind = priceFire.fired ? ALERT_KIND_PRICE : ALERT_KIND_PERCENT;
    const payload: Record<string, unknown> = {
      contractAddress: tokenId,
      symbol: token.symbol,
      currentPrice: sample.priceUsd,
      source: sample.source,
      sampledAt: sample.timestamp,
    };
    if (pctFire.fired) {
      payload.deltaPercent = pctFire.deltaPercent;
      payload.timeframeMinutes = watch.percentTimeframeMinutes;
    }
    if (priceFire.fired && watch.priceThresholdUsd !== null) {
      payload.threshold = watch.priceThresholdUsd;
    }
    payload.deltaUsd = pctFire.fired ? pctFire.deltaUsd : (watch.priceThresholdUsd !== null ? sample.priceUsd - watch.priceThresholdUsd : undefined);

    // Update watch state to record what triggered.
    watch.lastAlertState = {
      lastPrice: sample.priceUsd,
      lastPercentChange: pctFire.deltaPercent,
    };
    watch.cooldownUntil = now + cfg.cooldownMinutes * 60_000;

    // Persist AlertEvent for admin reporting.
    store.recordAlertEvent({
      userId: user.telegramChatId,
      tokenId,
      type: kind === ALERT_KIND_PRICE ? "price" : "percent",
      firedAt: now,
      payload: {
        currentPrice: sample.priceUsd,
        deltaUsd: payload.deltaUsd as number | undefined,
        deltaPercent: payload.deltaPercent as number | undefined,
        timeframeMinutes: watch.percentTimeframeMinutes,
        source: sample.source,
      },
    });

    // Enqueue outbox row, respecting quiet hours.
    const dueAt = computeDueAt(user, sample.timestamp, cfg);
    store.enqueueOutbox({
      userId: user.telegramChatId,
      chatId: user.telegramChatId,
      kind,
      payload,
      dueAt,
    });
  }
}

function shouldFirePrice(watch: Watch, price: number): { fired: boolean } {
  if (watch.priceThresholdUsd === null) return { fired: false };
  const t = watch.priceThresholdUsd;
  const last = watch.lastAlertState.lastPrice;
  // Fire when crossing the threshold from below.
  if (last === undefined) return { fired: price >= t };
  if (last < t && price >= t) return { fired: true };
  if (last > t && price <= t) return { fired: true };
  return { fired: false };
}

function shouldFirePercent(
  store: Store,
  watch: Watch,
  current: PriceSample,
  band: number,
): { fired: boolean; deltaPercent: number; deltaUsd: number } {
  const windowMs = watch.percentTimeframeMinutes * 60_000;
  const baseline = store.sampleAtOrBefore(watch.tokenId, current.timestamp - windowMs);
  if (!baseline) return { fired: false, deltaPercent: 0, deltaUsd: 0 };
  const deltaPct = ((current.priceUsd - baseline.priceUsd) / baseline.priceUsd) * 100;
  const deltaUsd = current.priceUsd - baseline.priceUsd;
  if (Math.abs(deltaPct) < watch.percentThreshold) return { fired: false, deltaPercent: deltaPct, deltaUsd };
  // Hysteresis: don't fire if the last fired change was within the band.
  const last = watch.lastAlertState.lastPercentChange;
  if (last !== undefined && Math.abs(deltaPct - last) < band * 100) {
    return { fired: false, deltaPercent: deltaPct, deltaUsd };
  }
  return { fired: true, deltaPercent: deltaPct, deltaUsd };
}

function computeDueAt(user: User, now: number, _cfg: BotConfig): number {
  if (!user.timezone) return now;
  if (!inQuietHours(user.timezone, user.quietHoursStart, user.quietHoursEnd, new Date(now))) {
    return now;
  }
  return quietHoursEndAt(user.timezone, user.quietHoursEnd, new Date(now));
}

/** Build a daily-summary outbox row for a user at their local summary time. */
export function scheduleDailySummary(store: Store, user: User, now = Date.now()): void {
  if (!user.timezone) return;
  if (!user.notificationPreferences.summaryEnabled) return;
  // Compose the same payload the on-demand /summary would render.
  const watches = store.listWatches(user.telegramChatId);
  if (watches.length === 0) return;
  const lines: Array<{ symbol: string; priceUsd: number; change1h: number; change24h: number }> = [];
  for (const w of watches) {
    const t = store.getToken(w.tokenId);
    const s = store.latestSample(w.tokenId);
    if (!t || !s) continue;
    const oneH = store.sampleAtOrBefore(w.tokenId, s.timestamp - 60 * 60_000);
    const oneD = store.sampleAtOrBefore(w.tokenId, s.timestamp - 24 * 60 * 60_000);
    lines.push({
      symbol: t.symbol,
      priceUsd: s.priceUsd,
      change1h: oneH ? ((s.priceUsd - oneH.priceUsd) / oneH.priceUsd) * 100 : 0,
      change24h: oneD ? ((s.priceUsd - oneD.priceUsd) / oneD.priceUsd) * 100 : 0,
    });
  }
  const payload: Record<string, unknown> = {
    kind: "summary",
    lines,
    source: "scheduled",
    sampledAt: now,
  };
  // Suppress duplicate: if a summary for this user is already pending, skip.
  if (store.outbox.some((o) => o.userId === user.telegramChatId && o.kind === ALERT_KIND_SUMMARY && o.state === "pending")) {
    return;
  }
  const dueAt = computeDueAt(user, now, { pollIntervalMs: 0, alertTickMs: 0, alertDrainBatch: 0, cooldownMinutes: 0, hysteresisBand: 0, sourceOutageMinutes: 0, adminChatIds: [] });
  store.enqueueOutbox({
    userId: user.telegramChatId,
    chatId: user.telegramChatId,
    kind: ALERT_KIND_SUMMARY,
    payload,
    dueAt,
  });
}

/** Bot-process owner of the outbox drainer. */
export class AlertEngine {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly bot: Pick<Bot, "api">,
    private readonly store: Store,
    private readonly cfg: BotConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), this.cfg.alertTickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Tick once. Public so the harness can drive it deterministically. */
  async drain(now = Date.now()): Promise<void> {
    const rows = this.store.listDueOutbox(now, this.cfg.alertDrainBatch);
    const deferredByUser = new Map<number, number>();
    for (const row of rows) {
      if (row.kind !== ALERT_KIND_SUMMARY && row.kind !== ALERT_KIND_OUTAGE) {
        if (row.dueAt - row.createdAt > 60_000) {
          deferredByUser.set(row.userId, (deferredByUser.get(row.userId) ?? 0) + 1);
        }
      }
    }
    const bannerSent = new Set<number>();
    for (const row of rows) {
      try {
        const deferredCount = deferredByUser.get(row.userId);
        let prefix = "";
        if (deferredCount !== undefined && !bannerSent.has(row.userId)) {
          prefix = `You have ${deferredCount} alert${deferredCount > 1 ? "s" : ""} from your quiet hours:\n\n`;
          bannerSent.add(row.userId);
        }
        const text = prefix + renderOutboxRow(row);
        await this.bot.api.sendMessage(row.chatId, text, {
          reply_markup: buildAlertKeyboard(row),
        });
        this.store.markOutboxSent(row.id);
      } catch (err) {
        this.store.markOutboxFailed(row.id, String(err));
      }
    }
  }
}

function renderOutboxRow(row: OutboxRow): string {
  const p = row.payload;
  if (row.kind === ALERT_KIND_SUMMARY) {
    const lines = (p.lines as Array<{ symbol: string; priceUsd: number; change1h: number; change24h: number }>) ?? [];
    const body = lines
      .map((l) => `• ${l.symbol} — ${l.priceUsd.toFixed(2)} USD  ${fmtPct(l.change1h)} (1h)  ${fmtPct(l.change24h)} (24h)`)
      .join("\n");
    return `📊 Daily summary\n${body}`;
  }
  if (row.kind === ALERT_KIND_OUTAGE) {
    return `⚠️ ${(p.message as string) ?? "Source outage"}`;
  }
  const symbol = (p.symbol as string) ?? "???";
  const price = (p.currentPrice as number).toFixed(2);
  const source = (p.source as string) ?? "TonSwap";
  if (row.kind === ALERT_KIND_PERCENT) {
    const pct = (p.deltaPercent as number).toFixed(1);
    const tf = (p.timeframeMinutes as number) ?? 60;
    return `🚨 ${symbol} moved ${pct}% over ${tf}m\n${price} USD\nSource: ${source}`;
  }
  // price
  const threshold = p.threshold !== undefined ? (p.threshold as number).toFixed(2) : "?";
  return `🚨 ${symbol} crossed ${threshold} USD\n${price} USD\nSource: ${source}`;
}

function fmtPct(p: number): string {
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(1)}%`;
}

function buildAlertKeyboard(row: OutboxRow) {
  // Snooze is only meaningful for price/percent alerts on a specific token.
  if (row.kind === ALERT_KIND_PERCENT || row.kind === ALERT_KIND_PRICE) {
    const contract = row.payload.contractAddress as string;
    return {
      inline_keyboard: [
        [
          { text: "View token", callback_data: `price:show:${contract}` },
          { text: "Snooze 1h", callback_data: `alert:snooze:60:${contract}` },
        ],
      ],
    };
  }
  if (row.kind === ALERT_KIND_OUTAGE) {
    const id = row.payload.adminRecordId as number | undefined;
    return id !== undefined
      ? { inline_keyboard: [[{ text: "Acknowledge", callback_data: `admin:ack:${id}` }]] }
      : undefined;
  }
  return undefined;
}

/** Register alert-related callback handlers: snooze button. */
export function registerAlertCallbacks(bot: Bot<Ctx>, store: Store): void {
  bot.callbackQuery(/^alert:snooze:60:(.+)$/, async (ctx) => {
    const contract = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.answerCallbackQuery({ text: "Not yours", show_alert: true });
      return;
    }
    const watch = store.getWatch(userId, contract);
    if (!watch) {
      await ctx.answerCallbackQuery({ text: "Watch not found", show_alert: false });
      return;
    }
    store.upsertWatch({ ...watch, cooldownUntil: Date.now() + 60 * 60_000 });
    await ctx.answerCallbackQuery({ text: "Snoozed alerts for 1 hour" });
  });
}
