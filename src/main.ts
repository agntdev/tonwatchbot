// Runtime entry: production. BOT_TOKEN is injected by the deploy container.
// ADMIN_CHAT_IDS is a comma-separated allowlist. The store is in-memory
// (per docs/details.md §0: the swap point is Store, handler code is
// unchanged). Poller + alert engine start after the bot is up.

import { buildBot } from "./bot.js";
import { configFromEnv } from "./config.js";
import { StubPriceSource } from "./prices.js";
import { PricePoller } from "./poller.js";
import { AlertEngine, evaluateAlerts } from "./alerts.js";
import { detectOutages } from "./commands/outage.js";
import { SummaryScheduler } from "./scheduler.js";
import { Store } from "./store.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("[tonwatchbot] BOT_TOKEN is required");
  process.exit(1);
}

const cfg = configFromEnv();
const store = new Store();
const prices = new StubPriceSource();
const bot = buildBot(token, { store, prices, cfg });
const poller = new PricePoller(store, prices, cfg, evaluateAlerts);
const engine = new AlertEngine(bot, store, cfg, (now) => detectOutages(poller, store, cfg, now));
const scheduler = new SummaryScheduler(store, cfg);

poller.start();
engine.start();
scheduler.start();

console.log("[tonwatchbot] starting long polling");
void bot.start();

// Graceful shutdown.
const shutdown = (): void => {
  console.log("[tonwatchbot] shutting down");
  poller.stop();
  engine.stop();
  scheduler.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
