// Runtime configuration. All env-driven; the harness builds the bot with
// explicit options and never touches process.env (per docs/details.md §0).

export interface BotConfig {
  /** Comma-separated numeric chat ids with admin access. Empty = no admins. */
  adminChatIds: number[];
  /** Price poller tick interval, ms. Default 60_000. */
  pollIntervalMs: number;
  /** Alert engine tick interval, ms. Default 1_000. */
  alertTickMs: number;
  /** How many outbox rows to drain per tick. Default 20. */
  alertDrainBatch: number;
  /** Cooldown after any alert, minutes. Default 60. */
  cooldownMinutes: number;
  /** Hysteresis band around a triggered threshold, as a fraction. Default 0.005. */
  hysteresisBand: number;
  /** Source-outage threshold, minutes. Default 5. */
  sourceOutageMinutes: number;
}

export function configFromEnv(): BotConfig {
  const admins = (process.env.ADMIN_CHAT_IDS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return {
    adminChatIds: admins,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60_000),
    alertTickMs: Number(process.env.ALERT_TICK_MS ?? 1_000),
    alertDrainBatch: Number(process.env.ALERT_DRAIN_BATCH ?? 20),
    cooldownMinutes: Number(process.env.COOLDOWN_MINUTES ?? 60),
    hysteresisBand: Number(process.env.HYSTERESIS_BAND ?? 0.005),
    sourceOutageMinutes: Number(process.env.SOURCE_OUTAGE_MINUTES ?? 5),
  };
}

/** "HH:MM" → minutes since midnight. */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes since midnight → "HH:MM". */
export function formatHHMM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Current local time in a user timezone as "HH:MM". */
export function localHHMM(tz: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: tz,
  }).formatToParts(now);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

/** True if the current local time in `tz` falls within the user's quiet
 *  hours window. Wraps past midnight correctly. */
export function inQuietHours(tz: string, startHHMM: string, endHHMM: string, now = new Date()): boolean {
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  if (start === null || end === null) return false;
  const cur = parseHHMM(localHHMM(tz, now));
  if (cur === null) return false;
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  // wraps past midnight
  return cur >= start || cur < end;
}

/** Local time at which the current quiet window ends, expressed as a UTC
 *  epoch ms. Used to schedule queued alerts. */
export function quietHoursEndAt(tz: string, endHHMM: string, now = new Date()): number {
  const endMin = parseHHMM(endHHMM) ?? 0;
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const localMidnightUtc = Date.UTC(y, mo - 1, d, 0, 0);
  // Use Intl to convert that local midnight to the real UTC.
  let guess = localMidnightUtc;
  for (let i = 0; i < 2; i++) {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: tz,
    }).formatToParts(new Date(guess + endMin * 60_000));
    const g = (t: string) => Number(fmt.find((p) => p.type === t)?.value);
    const rendered = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
    const want = Date.UTC(y, mo - 1, d, Math.floor(endMin / 60), endMin % 60);
    guess += want - rendered;
  }
  // If the computed end-of-quiet is already in the past, schedule for tomorrow.
  if (guess <= now.getTime()) guess += 24 * 60 * 60 * 1000;
  return guess;
}
