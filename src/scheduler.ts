// Daily-summary scheduler. Ticks every 60 s, checks each user's local
// time against their configured summary_time, and enqueues a daily-summary
// outbox row via scheduleDailySummary when it matches.
//
// Owned by the bot process (src/main.ts). The harness does not use it.

import { scheduleDailySummary } from "./alerts.js";
import { localHHMM } from "./config.js";
import type { Store } from "./store.js";

export class SummaryScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly store: Store) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    // Fire one tick soon after startup so a freshly-onboarded user whose
    // summary time is now gets a summary quickly.
    setTimeout(() => void this.tick(), 5_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Tick once. Public so the harness can drive it in future tests. */
  tick(now = Date.now()): void {
    const nowDate = new Date(now);
    for (const user of this.store.users.values()) {
      if (!user.timezone) continue;
      if (!user.notificationPreferences.summaryEnabled) continue;
      const local = localHHMM(user.timezone, nowDate);
      if (local === user.summaryTime) {
        scheduleDailySummary(this.store, user, now);
      }
    }
  }
}
