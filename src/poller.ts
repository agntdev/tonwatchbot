// Price poller. Every `pollIntervalMs` it walks the set of tokens that have
// at least one enabled watch, fetches the latest USD price from the price
// source, appends a PriceSample to the store, and asks the alert engine to
// evaluate alerts for the affected watches.
//
// The poller is a plain class, owned by the bot process. The production
// entry starts it after `bot.start()`. The harness skips it (no need to
// actually tick during a single dialog replay).

import type { BotConfig } from "./config.js";
import type { PriceSource } from "./prices.js";
import type { Store } from "./store.js";
import type { evaluateAlerts } from "./alerts.js";

export class PricePoller {
  private timer: NodeJS.Timeout | null = null;
  private inflight = false;
  private lastSuccessBySource = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly prices: PriceSource,
    private readonly cfg: BotConfig,
    private readonly onEvaluate: typeof evaluateAlerts,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.pollIntervalMs);
    // Fire one tick soon after startup so the first sample lands quickly.
    setTimeout(() => void this.tick(), 1_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Record a successful price source call (used by the alert engine to
   *  detect source outages). */
  recordSourceSuccess(source: string): void {
    this.lastSuccessBySource.set(source, Date.now());
  }

  /** Last success timestamp for a source, or undefined. */
  lastSuccess(source: string): number | undefined {
    return this.lastSuccessBySource.get(source);
  }

  /** Tokens that have at least one enabled watch. */
  private activeTokenIds(): string[] {
    const ids = new Set<string>();
    for (const w of this.store.listAllEnabledWatches()) ids.add(w.tokenId);
    return Array.from(ids);
  }

  private async tick(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      for (const tokenId of this.activeTokenIds()) {
        try {
          const r = await this.prices.latest(tokenId);
          this.recordSourceSuccess(r.source);
          this.store.appendPriceSample({
            tokenId,
            timestamp: r.sampledAt,
            priceUsd: r.priceUsd,
            source: r.source,
          });
          // Run the alert engine for this token — it's a pure function over
          // the store + the new sample.
          this.onEvaluate(this.store, this.cfg, tokenId);
        } catch (err) {
          console.error("[tonwatchbot] price fetch failed", tokenId, err);
        }
      }
    } finally {
      this.inflight = false;
    }
  }
}
