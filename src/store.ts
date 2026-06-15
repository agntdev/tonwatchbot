// Storage layer. Mirrors the schema in docs/general.md Core Entities plus
// the alerts_outbox table from docs/design.md §6.
//
// Engine: in-memory (the toolkit's blessed default persistence — the
// production swap point is this one class; the handler code only sees the
// query methods). The shape matches the relational design 1:1 so a future
// SQLite/Postgres adapter is a mechanical port.

import type {
  AdminRecord,
  AlertEvent,
  OutboxRow,
  PriceSample,
  Token,
  User,
  Watch,
} from "./types.js";

export interface UserKey {
  telegramChatId: number;
}

/** Returned by admin stats and similar aggregations. */
export interface TopToken {
  contractAddress: string;
  symbol: string;
  alertCount: number;
  uniqueUserCount: number;
}

export class Store {
  users = new Map<number, User>();
  tokens = new Map<string, Token>();
  /** Composite key: `${userId}::${tokenId}`. */
  watches = new Map<string, Watch>();
  /** Append-only log of price samples, indexed for fast latest + window queries. */
  priceSamples: PriceSample[] = [];
  alertEvents: AlertEvent[] = [];
  adminRecords = new Map<number, AdminRecord>();
  outbox: OutboxRow[] = [];
  private nextAdminId = 1;
  private nextOutboxId = 1;

  // ── users ──────────────────────────────────────────────────────────────
  getOrCreateUser(telegramChatId: number): User {
    let u = this.users.get(telegramChatId);
    if (!u) {
      u = {
        telegramChatId,
        timezone: null,
        quietHoursStart: "23:00",
        quietHoursEnd: "07:00",
        summaryTime: "08:00",
        notificationPreferences: {
          summaryEnabled: true,
          alertTypes: ["price", "percent"],
          defaultPercentThreshold: 5,
          defaultPercentTimeframeMinutes: 60,
        },
      };
      this.users.set(telegramChatId, u);
    }
    return u;
  }

  updateUser(telegramChatId: number, patch: Partial<Omit<User, "telegramChatId">>): User {
    const u = this.getOrCreateUser(telegramChatId);
    Object.assign(u, patch);
    return u;
  }

  // ── tokens ─────────────────────────────────────────────────────────────
  upsertToken(t: Token): Token {
    const existing = this.tokens.get(t.contractAddress);
    if (existing) {
      Object.assign(existing, t);
      return existing;
    }
    this.tokens.set(t.contractAddress, t);
    return t;
  }

  getToken(contractAddress: string): Token | undefined {
    return this.tokens.get(contractAddress);
  }

  // ── watches ────────────────────────────────────────────────────────────
  watchKey(userId: number, tokenId: string): string {
    return `${userId}::${tokenId}`;
  }

  upsertWatch(w: Watch): Watch {
    this.watches.set(this.watchKey(w.userId, w.tokenId), w);
    return w;
  }

  getWatch(userId: number, tokenId: string): Watch | undefined {
    return this.watches.get(this.watchKey(userId, tokenId));
  }

  deleteWatch(userId: number, tokenId: string): void {
    this.watches.delete(this.watchKey(userId, tokenId));
  }

  listWatches(userId: number): Watch[] {
    const out: Watch[] = [];
    for (const w of this.watches.values()) if (w.userId === userId) out.push(w);
    return out;
  }

  listEnabledWatchesForToken(tokenId: string): Watch[] {
    const out: Watch[] = [];
    for (const w of this.watches.values()) {
      if (w.tokenId === tokenId && w.enabled) out.push(w);
    }
    return out;
  }

  listAllEnabledWatches(): Watch[] {
    return Array.from(this.watches.values()).filter((w) => w.enabled);
  }

  // ── price samples ──────────────────────────────────────────────────────
  appendPriceSample(s: PriceSample): void {
    this.priceSamples.push(s);
  }

  /** Latest sample for a token, or undefined. */
  latestSample(tokenId: string): PriceSample | undefined {
    for (let i = this.priceSamples.length - 1; i >= 0; i--) {
      const s = this.priceSamples[i]!;
      if (s.tokenId === tokenId) return s;
    }
    return undefined;
  }

  /** Oldest sample within the last `windowMs`, or undefined. */
  sampleAtOrBefore(tokenId: string, cutoffMs: number): PriceSample | undefined {
    let chosen: PriceSample | undefined;
    for (let i = this.priceSamples.length - 1; i >= 0; i--) {
      const s = this.priceSamples[i]!;
      if (s.tokenId !== tokenId) continue;
      if (s.timestamp <= cutoffMs) return s;
      chosen = s;
    }
    return chosen;
  }

  // ── alert events ───────────────────────────────────────────────────────
  recordAlertEvent(e: AlertEvent): void {
    this.alertEvents.push(e);
  }

  countAlertsSince(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let n = 0;
    for (let i = this.alertEvents.length - 1; i >= 0; i--) {
      if (this.alertEvents[i]!.firedAt < cutoff) break;
      n++;
    }
    return n;
  }

  topTokensByAlerts(windowMs: number, limit: number): TopToken[] {
    const cutoff = Date.now() - windowMs;
    const counts = new Map<string, { count: number; users: Set<number> }>();
    for (const e of this.alertEvents) {
      if (e.firedAt < cutoff) continue;
      if (!e.tokenId) continue;
      const cur = counts.get(e.tokenId) ?? { count: 0, users: new Set<number>() };
      cur.count++;
      cur.users.add(e.userId);
      counts.set(e.tokenId, cur);
    }
    const sorted = Array.from(counts.entries())
      .map(([tokenId, v]) => ({
        contractAddress: tokenId,
        symbol: this.tokens.get(tokenId)?.symbol ?? "???",
        alertCount: v.count,
        uniqueUserCount: v.users.size,
      }))
      .sort((a, b) => b.alertCount - a.alertCount)
      .slice(0, limit);
    return sorted;
  }

  recentAlertEvents(limit: number): AlertEvent[] {
    return this.alertEvents.slice(-limit).reverse();
  }

  // ── admin records ─────────────────────────────────────────────────────
  createAdminRecord(r: Omit<AdminRecord, "id">): AdminRecord {
    const id = this.nextAdminId++;
    const full: AdminRecord = { id, ...r };
    this.adminRecords.set(id, full);
    return full;
  }

  getAdminRecord(id: number): AdminRecord | undefined {
    return this.adminRecords.get(id);
  }

  ackAdminRecord(id: number): void {
    const r = this.adminRecords.get(id);
    if (r) r.open = false;
  }

  findOpenAdminRecordBySource(source: string): AdminRecord | undefined {
    for (const r of this.adminRecords.values()) {
      if (r.open && r.source === source && r.kind === "source_outage") return r;
    }
    return undefined;
  }

  // ── outbox ─────────────────────────────────────────────────────────────
  enqueueOutbox(row: Omit<OutboxRow, "id" | "createdAt" | "state" | "attempts" | "lastError">): OutboxRow {
    const id = this.nextOutboxId++;
    const full: OutboxRow = { id, createdAt: Date.now(), state: "pending", attempts: 0, lastError: null, ...row };
    this.outbox.push(full);
    return full;
  }

  listDueOutbox(now: number, limit: number): OutboxRow[] {
    const due: OutboxRow[] = [];
    for (const r of this.outbox) {
      if (r.state !== "pending") continue;
      if (r.dueAt > now) continue;
      due.push(r);
      if (due.length >= limit) break;
    }
    return due;
  }

  markOutboxSent(id: number): void {
    const r = this.outbox.find((o) => o.id === id);
    if (r) r.state = "sent";
  }

  markOutboxFailed(id: number, err: string): void {
    const r = this.outbox.find((o) => o.id === id);
    if (!r) return;
    r.attempts++;
    r.lastError = err;
    if (r.attempts >= 5) r.state = "failed";
  }

  /** Total active user count (for /admin_stats). */
  countUsers(): number {
    return this.users.size;
  }

  /** List users with pagination. */
  listUsersPaginated(page: number, pageSize: number): User[] {
    const all = Array.from(this.users.values());
    const start = (page - 1) * pageSize;
    return all.slice(start, start + pageSize);
  }
}
