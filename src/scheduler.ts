// Daily-summary scheduler. Every `summaryCheckIntervalMs` it walks all
// users that have a timezone and summary enabled, checks whether their
// local time is at or past their configured `summaryTime`, and calls the
// pure `scheduleDailySummary` function, which handles deduplication
// (one summary per local calendar day) and outbox enqueue.
//
// The scheduler is owned by the bot process. The production entry starts
// it after `bot.start()`. The harness skips it.

import { localHHMM, parseHHMM, type BotConfig } from "./config.js";
import type { Store } from "./store.js";
import { scheduleDailySummary } from "./alerts.js";

export class SummaryScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly cfg: BotConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.summaryCheckIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Tick once. Public so the harness can drive it deterministically. */
  tick(now = Date.now()): void {
    for (const user of this.store.users.values()) {
      if (!user.timezone) continue;
      if (!user.notificationPreferences.summaryEnabled) continue;
      const local = localHHMM(user.timezone, new Date(now));
      const localMin = parseHHMM(local);
      const summaryMin = parseHHMM(user.summaryTime);
      if (localMin === null || summaryMin === null) continue;
      if (localMin >= summaryMin) {
        scheduleDailySummary(this.store, user, now);
      }
    }
  }
}

