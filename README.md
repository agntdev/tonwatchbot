# TonWatchBot

Telegram bot to privately watch TON and TON jettons, send clear absolute-price and percent-move alerts, with quiet hours, daily summaries, and owner reports.

Built with [grammY](https://grammy.dev) and `@agntdev/bot-toolkit`.

## Features

- **Token watchlist** — add TON and jetton contract addresses, get current prices with 1h/24h percent change.
- **Price alerts** — absolute USD threshold and percent-move triggers with configurable timeframes.
- **Anti-spam** — cooldown after every alert (60 min default), hysteresis around triggered thresholds (0.5% default), and per-user quiet hours (23:00–07:00 default).
- **Daily summaries** — scheduled at each user's local summary time or on demand via `/summary`.
- **Admin reports** — `/admin_stats`, `/admin_users`, `/admin_alerts`, `/admin_export` for the bot owner.

## Commands

| Command | Description |
|---|---|
| `/start` | First-time onboarding: set timezone, quiet hours, daily summary time. |
| `/help` | Print the command list. |
| `/add <contract>` | Validate a TON/jetton address and add it to your watchlist with confirmation. |
| `/remove` | Show your watchlist with inline remove buttons. |
| `/list` | List watched tokens with current price, 1h %, 24h %, and per-token action buttons. |
| `/price <contract>` | Show the current USD price, 1h and 24h change, and data source for any contract. |
| `/summary` | Render the daily-summary card on demand. |
| `/settings` | Main settings menu: timezone, quiet hours, summary time, default percent threshold, default timeframe. |
| `/admin_stats` | (admin) Users, watches, 24h alert count, top-5 tokens by alert volume. |
| `/admin_users [page]` | (admin) Paginated user list with timezone and watch count. |
| `/admin_alerts <24h\|7d\|30d>` | (admin) Top tokens and recent alert events. |
| `/admin_export <users\|alerts> <24h\|7d\|30d>` | (admin) CSV export. |

## Configuration

All settings come from environment variables:

| Variable | Default | Description |
|---|---|---|
| `BOT_TOKEN` | *(required)* | Telegram bot token from [@BotFather](https://t.me/BotFather). |
| `ADMIN_CHAT_IDS` | `""` | Comma-separated numeric chat IDs with admin access. |
| `POLL_INTERVAL_MS` | `60000` | Price poller tick interval in milliseconds. |
| `ALERT_TICK_MS` | `1000` | Alert engine drain interval. |
| `ALERT_DRAIN_BATCH` | `20` | Max outbox rows drained per tick. |
| `COOLDOWN_MINUTES` | `60` | Cooldown after any alert. |
| `HYSTERESIS_BAND` | `0.005` | Hysteresis band (fraction) around triggered thresholds. |
| `SOURCE_OUTAGE_MINUTES` | `5` | Minutes before marking a price source as down. |

## Development

```sh
npm ci          # install dependencies
npm run build   # compile TypeScript to dist/
npm test        # run the end-to-end dialog spec harness
```

`npm test` replays every dialog flow from `tests/specs.json` against a fresh bot instance built from `src/harness-entry.ts`. All 12 commands and 44 dialog scenarios are verified.

## Architecture

A single Node.js process with four logical workers:

- **Bot router** (grammY) — handles Telegram Updates (commands, callbacks, text dialogs).
- **Dialog flows** — multi-step interactions driven by per-chat session state and inline keyboards.
- **Alert engine** — drains the alerts outbox, applies quiet-hour deferrals, and delivers messages.
- **Price poller** — ticks every 60s, fetches prices for watched tokens, and evaluates alert thresholds.

All state lives in an in-memory `Store` class whose interface mirrors the relational schema in `docs/general.md`. Swap the store implementation to PostgreSQL for production.

## Project structure

```
src/
├── bot.ts           Bot assembly: createBot, middleware, command registration, text/callback routers.
├── main.ts          Production entry: reads env, starts bot + poller + alert engine + summary scheduler.
├── harness-entry.ts Tokenless factory: same bot but injectable store, used by the test harness.
├── config.ts        Env config + timezone/quiet-hours utilities.
├── session.ts       Per-chat session shape (active dialog state).
├── store.ts         In-memory store: users, tokens, watches, price samples, alerts, outbox.
├── types.ts         Shared TypeScript types.
├── poller.ts        Price poller: ticks every `pollIntervalMs`, fetches prices, evaluates alerts.
├── prices.ts        Price source interface + `StubPriceSource` for dev/testing.
├── alerts.ts        Alert engine: threshold evaluation, outbox enqueue, outbox drain.
├── scheduler.ts     Daily summary scheduler: checks per-minute whether any user's summary time has arrived.
├── middleware.ts     Admin allowlist guard for `/admin_*` commands.
└── commands/
    ├── start.ts         /start onboarding + timezone + defaults dialogs.
    ├── add.ts           /add contract validation and confirmation.
    ├── list_remove.ts   /list watchlist render and /remove.
    ├── price.ts         /price query with 1h/24h change.
    ├── settings.ts      /settings menu + sub-dialogs (quiet hours, summary time, defaults).
    ├── watch_settings.ts Per-watch alert settings (absolute threshold, percent, timeframe).
    ├── alerts.ts        On-demand /summary, snooze, and other alert UX callbacks.
    ├── admin.ts         /admin_stats, /admin_users, /admin_alerts, /admin_export.
    └── outage.ts        Source-outage detection and admin ack callbacks.
```

## License

See `THIRD_PARTY.md` for vendored dependency information.