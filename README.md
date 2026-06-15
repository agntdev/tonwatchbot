# tonwatchbot

Telegram bot to privately watch TON and TON jettons, send clear
absolute-price and percent-move alerts, with quiet hours, daily summaries,
and owner reports.

This bot was built on the AGNTDEV pipeline from these specs:

- [`docs/general.md`](docs/general.md) — top-level requirements
- [`docs/design.md`](docs/design.md) — architecture, command set, UX flows
- [`docs/details.md`](docs/details.md) — per-command behaviour spec
- [`docs/work_breakdown.json`](docs/work_breakdown.json) — the Dev DAG

## Commands

### User

| Command | Args | What it does |
|---|---|---|
| `/start` | — | First-time onboarding (timezone + default quiet/summary) or "Welcome back" |
| `/add` | `<contract>` | Resolve the contract, confirm, add to watchlist with default alerts |
| `/remove` | — | Show inline remove buttons, tap to confirm |
| `/list` | — | Watchlist with current prices, 1h/24h change, per-token buttons |
| `/price` | `<contract>` | Current USD price, 1h/24h change, source + timestamp |
| `/summary` | — | On-demand daily-style summary of all watched tokens |
| `/settings` | — | Timezone, quiet hours, summary time, default percent + timeframe |
| `/help` | — | Command list |

### Admin (allowlisted chat ids only)

| Command | Args | What it does |
|---|---|---|
| `/admin_stats` | — | Total users, active watches, last-24h alert count + top tokens |
| `/admin_users` | `page` | Paginated list of users |
| `/admin_alerts` | `24h` / `7d` / `30d` | Top tokens by alert count + recent log |
| `/admin_export` | `users\|alerts <period>` | CSV file of the chosen slice |

## Architecture (one Node process)

```
Telegram (long poll / webhook)
  └── grammY bot (src/bot.ts)
        ├── command + dialog + callback handlers (src/commands/*.ts)
        └── AlertEngine (src/alerts.ts)
              ├── drains alerts_outbox
              └── detectOutages() → admin chat for stuck sources

PricePoller (src/poller.ts, 60s tick)
  └── StubPriceSource (TonSwap → The Graph → CoinGecko)

DailySummaryScheduler (src/scheduler.ts, 60s tick)
  └── enqueues a summary for any user whose local summary_time matches
```

The in-memory `Store` (src/store.ts) mirrors the schema in
`docs/general.md` Core Entities plus the `alerts_outbox` table. The
production swap point for a real DB is `Store` — handler code is
unchanged.

## Configuration (env)

| Env var | Default | Meaning |
|---|---|---|
| `BOT_TOKEN` | — (required) | Telegram BotFather token |
| `ADMIN_CHAT_IDS` | empty | Comma-separated numeric chat ids |
| `POLL_INTERVAL_MS` | 60000 | Price poller tick |
| `ALERT_TICK_MS` | 1000 | Alert engine tick |
| `ALERT_DRAIN_BATCH` | 20 | Outbox rows drained per tick |
| `COOLDOWN_MINUTES` | 60 | Cooldown after any alert |
| `HYSTERESIS_BAND` | 0.005 | 0.5% hysteresis around triggered thresholds |
| `SOURCE_OUTAGE_MINUTES` | 5 | Source-down threshold for admin alerts |

## Development

```sh
npm install
npm run typecheck
npm run build
npm test
```

`npm test` runs the AGNTDEV harness in tokenless mode. It:

1. Builds the bot from `dist/harness-entry.js`
2. Replays 47 dialog specs against fresh bot instances
3. Computes command coverage vs the declared command list
4. Emits a single GATE JSON line on stdout

The spec format and harness behaviour are documented in
`.agents/skills/telegram-test-specs/`.

## Deployment

The runtime entry is `dist/main.js` (the platform injects `BOT_TOKEN`):

```sh
node dist/main.js
```

Graceful shutdown on SIGINT / SIGTERM. The bot uses long polling in the
default build; switch to webhook by setting the appropriate grammY
options in `src/main.ts`.
