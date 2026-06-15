// Shared types for the bot. Mirror the schema in docs/general.md Core Entities
// plus the alerts_outbox table introduced in docs/design.md §6. All times are
// stored as UTC epoch ms; all money is USD stored as number (we never lose
// precision with the 8-decimal `numeric` type behaviour we model in JS).

/** A user row (telegram_chat_id is the natural primary key). */
export interface User {
  telegramChatId: number;
  /** IANA timezone, e.g. "Europe/Berlin". null until /start completes. */
  timezone: string | null;
  /** "HH:MM" in 24h, the user's local quiet-hours window start. */
  quietHoursStart: string;
  /** "HH:MM" in 24h, the user's local quiet-hours window end. */
  quietHoursEnd: string;
  /** "HH:MM" in 24h, the user's local daily-summary time. */
  summaryTime: string;
  /** JSON blob matching the schema in docs/general.md User. */
  notificationPreferences: {
    summaryEnabled: boolean;
    alertTypes: Array<"price" | "percent">;
    defaultPercentThreshold: number;
    defaultPercentTimeframeMinutes: number;
  };
}

/** A watched token (jetton or native TON). */
export interface Token {
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  metadataSource: "TonSwap" | "The Graph" | "CoinGecko";
}

/** Per-user watch on a token. */
export interface Watch {
  userId: number;
  tokenId: string;
  enabled: boolean;
  /** Absolute USD price threshold; null = not set. */
  priceThresholdUsd: number | null;
  /** Percent threshold (e.g. 5.0 means 5%). */
  percentThreshold: number;
  /** Timeframe for the percent threshold, in minutes. */
  percentTimeframeMinutes: number;
  /** Last alert state, used for hysteresis. */
  lastAlertState: { lastPrice?: number; lastPercentChange?: number };
  /** Epoch ms until which no new alerts are sent. */
  cooldownUntil: number;
}

/** A single price sample. */
export interface PriceSample {
  tokenId: string;
  /** UTC epoch ms. */
  timestamp: number;
  priceUsd: number;
  source: "TonSwap" | "The Graph" | "CoinGecko";
}

export type AlertType = "price" | "percent" | "summary" | "source_outage";

/** A persisted alert event. */
export interface AlertEvent {
  userId: number;
  tokenId: string | null;
  type: AlertType;
  /** UTC epoch ms. */
  firedAt: number;
  payload: {
    currentPrice?: number;
    deltaUsd?: number;
    deltaPercent?: number;
    timeframeMinutes?: number;
    source?: string;
  };
}

/** Per-source outage record. */
export interface AdminRecord {
  id: number;
  tokenId: string | null;
  kind: "source_outage" | "queue_backlog" | "fatal_error";
  source?: string;
  alertCount: number;
  lastAlertTime: number;
  /** Open until acknowledged. */
  open: boolean;
}

/** A row in the alerts_outbox, drained by the alert engine. */
export interface OutboxRow {
  id: number;
  userId: number;
  chatId: number;
  kind: "price" | "percent" | "summary" | "source_outage";
  payload: Record<string, unknown>;
  /** UTC epoch ms; the row is eligible to be sent at or after this time. */
  dueAt: number;
  state: "pending" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
}

/** Result of resolving a contract address. */
export interface ResolvedToken {
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number;
  source: "TonSwap" | "The Graph" | "CoinGecko";
  sampledAt: number;
}

/** Result of a price query. */
export interface PriceQuote {
  contractAddress: string;
  symbol: string;
  priceUsd: number;
  change1h: number;
  change24h: number;
  source: "TonSwap" | "The Graph" | "CoinGecko";
  sampledAt: number;
}
