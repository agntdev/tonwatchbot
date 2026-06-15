// Price source client. The real production deployment wires up TonSwap →
// The Graph → CoinGecko (in priority order, see docs/general.md External
// Dependencies). For the foundation we ship a clean interface and a stub
// implementation that returns plausible mock data — feature tasks swap in
// the real fetchers without touching the alert engine or the poller.
//
// The price source is injected into buildBot, so the harness can substitute
// a deterministic stub that drives the alerts logic without HTTP.

import type { PriceQuote, ResolvedToken, Token } from "./types.js";

export class TokenNotFoundError extends Error {
  constructor(public readonly contract: string) {
    super(`token not found: ${contract}`);
    this.name = "TokenNotFoundError";
  }
}

export interface PriceSource {
  /** Resolve a contract address to token metadata + current USD price. */
  resolveToken(contract: string): Promise<ResolvedToken>;
  /** Fetch the latest USD price for a known token. */
  latest(contract: string): Promise<{ priceUsd: number; source: ResolvedToken["source"]; sampledAt: number }>;
}

/** Deterministic in-memory price source. Used by tests and as the default
 *  during local dev. Prices are pseudo-random within a stable range per
 *  contract so the alert engine has something to react to. */
export class StubPriceSource implements PriceSource {
  private state = new Map<string, { token: ResolvedToken; drift: number }>();

  constructor(private readonly seedBase: number = 1) {}

  async resolveToken(contract: string): Promise<ResolvedToken> {
    const cur = this.state.get(contract);
    if (cur) {
      // Drift the price a little to simulate market movement.
      cur.drift = (cur.drift * 0.95) + (Math.random() - 0.5) * 0.02;
      cur.token.priceUsd = Math.max(0.0001, cur.token.priceUsd * (1 + cur.drift));
      cur.token.sampledAt = Date.now();
      return cur.token;
    }
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(contract)) {
      throw new TokenNotFoundError(contract);
    }
    // Use a stable hash of the address to derive symbol/name so the same
    // contract always returns the same token.
    let h = 0;
    for (let i = 0; i < contract.length; i++) h = (h * 31 + contract.charCodeAt(i)) | 0;
    const symbol = `T${(Math.abs(h) % 9000 + 1000).toString(36).toUpperCase()}`;
    const base = this.seedBase + (Math.abs(h) % 1000) / 100;
    const t: ResolvedToken = {
      contractAddress: contract,
      symbol,
      name: `Mock ${symbol}`,
      decimals: 9,
      priceUsd: base,
      source: "TonSwap",
      sampledAt: Date.now(),
    };
    this.state.set(contract, { token: t, drift: 0 });
    return t;
  }

  async latest(contract: string): Promise<{ priceUsd: number; source: ResolvedToken["source"]; sampledAt: number }> {
    const t = await this.resolveToken(contract);
    return { priceUsd: t.priceUsd, source: t.source, sampledAt: t.sampledAt };
  }
}

/** Convert a `ResolvedToken` to the persisted `Token` shape. */
export function resolvedToToken(r: ResolvedToken): Token {
  return {
    contractAddress: r.contractAddress,
    symbol: r.symbol,
    name: r.name,
    decimals: r.decimals,
    metadataSource: r.source,
  };
}

/** Compute percent change between two prices, returning 0 when the base
 *  price is zero or negative. */
export function percentChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from <= 0) return 0;
  return ((to - from) / from) * 100;
}

/** Build a `PriceQuote` from two samples (current + 1h-old + 24h-old). */
export function buildQuote(
  contract: string,
  symbol: string,
  now: { priceUsd: number; source: ResolvedToken["source"]; sampledAt: number },
  oneHourAgo: number | undefined,
  oneDayAgo: number | undefined,
): PriceQuote {
  return {
    contractAddress: contract,
    symbol,
    priceUsd: now.priceUsd,
    change1h: oneHourAgo !== undefined ? percentChange(oneHourAgo, now.priceUsd) : 0,
    change24h: oneDayAgo !== undefined ? percentChange(oneDayAgo, now.priceUsd) : 0,
    source: now.source,
    sampledAt: now.sampledAt,
  };
}
