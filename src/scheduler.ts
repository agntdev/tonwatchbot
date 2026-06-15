// Daily summary scheduler (docs/details.md §4.2, design §4.5).
//
// Every minute, the scheduler walks the user table and enqueues a
// summary outbox row for any user whose `summary_time` matches the
// current minute IN THEIR TIMEZONE and whose summary is enabled. The
// alert engine then drains it under the same quiet-hours rules as price
// alerts (no duplicate if a manual /summary was sent while the queued
// one was pending — handled in scheduleDailySummary).

import { localHHMM } from "./config.js";
import { scheduleDailySummary } from "./alerts.js";
import type { Store } from "./store.js";

export class DailySummaryScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly tickMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Fire one tick soon after startup so summaries due in the next
    // minute get enqueued promptly.
    setTimeout(() => this.tick(), 1_500);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Public so the harness / tests can drive a tick deterministically. */
  tick(now = new Date()): void {
    for (const user of this.store.users.values()) {
      if (!user.timezone) continue;
      if (!user.notificationPreferences.summaryEnabled) continue;
      const local = localHHMM(user.timezone, now);
      if (local === user.summaryTime) {
        scheduleDailySummary(this.store, user, now.getTime());
      }
    }
  }
}
