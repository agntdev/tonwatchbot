// Tokenless factory for the test harness. Builds the SAME bot as main.ts
// with a dummy token, a fresh in-memory store, a deterministic price
// source, and a fixed admin id. Never calls .start() — no top-level side
// effects; everything happens inside makeBot() so the harness can replay
// dialog specs against a fresh bot each time.

import type { Bot } from "grammy";
import { buildBot, type Ctx } from "./bot.js";
import { configFromEnv } from "./config.js";
import { StubPriceSource } from "./prices.js";
import { Store } from "./store.js";

/** Chat id the harness uses when sending admin-only commands. */
export const HARNESS_ADMIN_CHAT_ID = 9000;

/** Default non-admin user the harness uses by default. */
export const HARNESS_USER_CHAT_ID = 1;

export function makeBot(): Bot<Ctx> {
  const cfg = {
    ...configFromEnv(),
    adminChatIds: [HARNESS_ADMIN_CHAT_ID],
    pollIntervalMs: 60_000,
    alertTickMs: 1_000,
    alertDrainBatch: 20,
    cooldownMinutes: 60,
    hysteresisBand: 0.005,
    sourceOutageMinutes: 5,
  };
  const store = new Store();
  const prices = new StubPriceSource();
  return buildBot("0:harness-tokenless", { store, prices, cfg });
}

export default makeBot;
