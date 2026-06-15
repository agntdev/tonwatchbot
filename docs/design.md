# TonWatchBot — Design Document

This document describes how TonWatchBot is built, the full set of Telegram
commands, and the conversation flows that satisfy `docs/general.md`.

## 1. Goals

- A user adds TON or a TON jetton by contract address and gets a single
  Telegram chat where that token's price is watched.
- The bot sends an alert when the price crosses a user-set absolute USD
  threshold, or moves by more than a user-set percent over a chosen
  timeframe.
- The bot never spams: there is a cooldown, hysteresis, quiet hours, and
  per-user daily summaries.
- The bot owner gets aggregated operational reports in a separate admin
  chat.

## 2. Architecture

A single Node.js process. Inside that process there are four logical
workers, sharing one PostgreSQL database.

```
┌──────────────────────────────────────────────────────────┐
│  Telegram (long poll or webhook)                         │
└──────────────────────┬───────────────────────────────────┘
                       │ Updates
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Bot process (grammY + @agntdev/bot-toolkit)             │
│                                                          │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Command    │  │ Dialog       │  │ Callback query   │  │
│  │ router     │  │ flows        │  │ router           │  │
│  └─────┬──────┘  └──────┬───────┘  └────────┬─────────┘  │
│        └────────┬───────┴───────────────────┘            │
│                 ▼                                        │
│         ┌──────────────┐                                 │
│         │ Alert engine │  ← reads from queue             │
│         └──────┬───────┘                                 │
│                │ sends messages                           │
└────────────────┼─────────────────────────────────────────┘
                 │                ▲
        enqueue  │                │  poll price
                 ▼                │
┌──────────────────────┐  ┌──────┴───────────────┐
│  Alerts queue        │  │  Price poller         │
│  (DB-backed)         │  │  60s tick             │
└──────────────────────┘  └──────┬───────────────┘
                                 │ fetch
                                 ▼
                       ┌──────────────────────┐
                       │  External price APIs │
                       │  TonSwap → Graph →   │
                       │  CoinGecko fallback  │
                       └──────────────────────┘

   All four workers share one PostgreSQL DB (users, tokens, watches,
   price_samples, alert_events, admin_records, alerts_outbox).
```

### 2.1 Workers

- **Bot router** — grammY bot. Receives every Telegram Update, runs
  command / dialog / callback handlers, replies.
- **Dialog flows** — multi-step interactions (onboarding timezone
  selection, add-token contract validation, per-watch alert settings).
  Implemented as inline-keyboard menus driven by `ctx.session`.
- **Alert engine** — pulls the next due alert from an outbox table,
  checks quiet hours and cooldown, and either sends it now or reschedules
  for after the quiet window.
- **Price poller** — every 60 seconds, for every enabled `Token`, fetch
  the latest USD price. Write a `PriceSample`. Run percent-move and
  absolute-threshold checks against all enabled `Watch` rows for that
  token and enqueue alerts.

### 2.2 External dependencies

- **Telegram Bot API** — long poll in dev, webhook in prod. The bot
  identity (`BOT_TOKEN`) is provided by `agnt bot show tonwatchbot` at
  deploy time, never hard-coded.
- **TonSwap API** — primary price source for TON and jettons.
- **The Graph** — secondary source for jetton pool data.
- **CoinGecko** — fallback for `TON/USD` only.
- **PostgreSQL** — single source of truth. Schema in `docs/general.md`,
  Core Entities section.

### 2.3 Failure modes

- A price source is down for >5 minutes: the alert engine writes a row
  to `admin_records` and the admin chat receives a `source_outage` alert.
- The alert engine crashes: on restart it picks up where the outbox left
  off. No alert is dropped.
- The bot cannot reach Telegram: outbound messages stay in `alerts_outbox`
  with `state = pending` and are retried on the next tick.

## 3. Full command set

All commands work in any chat the bot is in. Admin commands (`/admin_*`)
require the sender's `telegram_chat_id` to be in the `admins` allowlist
configured at deploy time.

### 3.1 Onboarding

| Command | Args | Behavior |
|---|---|---|
| `/start` | — | First-time welcome. If the user has no row in `users`, create one and ask for a timezone (inline keyboard: common zones + "Enter manually"). |
| `/help` | — | Print the command list. |

### 3.2 Watchlist

| Command | Args | Behavior |
|---|---|---|
| `/add` | `<contract_address>` | Validate the address via on-chain lookup (TonSwap / The Graph). Show a confirmation card with the resolved symbol, name, decimals, and current USD price. Confirm button inserts the `Token` (if new) and the `Watch` row with default thresholds. |
| `/remove` | — | Show the user's watchlist as a list of inline buttons. Each button removes the corresponding `Watch`. |
| `/list` | — | List watched tokens with current price, 1h %, 24h %, and quick-action buttons (`Price`, `Remove`, `Settings`). |

### 3.3 Price

| Command | Args | Behavior |
|---|---|---|
| `/price` | `<contract_address>` or empty | If empty and a button is attached, show the last picked token. Show the current USD price, 1h and 24h percent change, and the source + timestamp of the sample. |
| `/summary` | — | Render the daily-summary card on demand: every watched token with its current price, 1h %, 24h %, and last alert time. |

### 3.4 Settings

| Command | Args | Behavior |
|---|---|---|
| `/settings` | — | Main settings menu, inline buttons: Timezone, Quiet hours, Summary time, Default percent threshold, Default percent timeframe. |
| `/settings quiet` | `HH:MM HH:MM` | Set quiet hours. Argument form for power users; the menu button opens a two-step dialog. |
| `/settings summary` | `HH:MM` | Set the local time the daily summary is sent. |

Per-token overrides: `/list` → "Settings" button on a watch row opens
that watch's settings dialog (absolute threshold, percent threshold,
percent timeframe).

### 3.5 Admin (allowlisted `telegram_chat_id` only)

| Command | Args | Behavior |
|---|---|---|
| `/admin_stats` | — | Total users, active watches, alerts in the last 24h, top-5 watched tokens. |
| `/admin_users` | `page` | Paginated list of users (chat id, timezone, watch count, last activity). |
| `/admin_alerts` | `24h` / `7d` / `30d` | Top tokens by alert count in the period, then a tail of the 20 most recent `AlertEvent` rows. |
| `/admin_export` | `users` / `alerts` `<period>` | Returns a CSV file of the chosen slice. |
| `/admin_alerts_ack` | `<event_id>` | Acknowledge a source-outage / backlog / fatal-error admin alert so it stops repeating. |

### 3.6 Cancel / fallback

| Trigger | Behavior |
|---|---|
| Inline button "Cancel" inside any dialog | Clear `ctx.session.step`, reply "Cancelled.", redraw the previous menu. |
| Unknown command (`/foo`) | Reply with a one-line hint: "Unknown command. Try /help." |
| Non-command text from a user not in a dialog | Ignore. |
| `callback_query` for a button not addressed to this user | `answerCallbackQuery({ text: "Not yours", show_alert: true })`. |

## 4. Conversation and UX flows

All multi-step flows are driven by `ctx.session` and inline keyboards.
No long-form natural-language parsing. The bot never asks two questions
in one message.

### 4.1 Onboarding (`/start`)

```
User:    /start
Bot:     Welcome to TonWatchBot! 👋
         To send alerts at the right time, pick your timezone:
         [Europe/London] [Europe/Berlin]
         [America/New_York] [America/Los_Angeles]
         [Asia/Singapore] [Asia/Tokyo]
         [Enter manually…]    [Cancel]

User:    [taps Europe/Berlin]
Bot:     Timezone set: Europe/Berlin.
         Quiet hours default to 23:00–07:00.
         Daily summary at 08:00.
         [Keep defaults]   [Change quiet hours]
                           [Change summary time]

User:    [taps Keep defaults]
Bot:     All set. Try /add <contract> to watch a token, or /help
         for the full command list.
```

`Enter manually…` opens a one-shot text prompt; the next message from
the user is treated as the IANA timezone string and validated.

### 4.2 Adding a token (`/add`)

```
User:    /add EQBicq4FZj4Y1q4Z8X1z3aBcDeFgH0iJkLmN7oP9qR5sT6uV
Bot:     Resolving token…
         ✅ Resolved: jUSDT (Wrapped Tether on TON)
         Decimals: 6
         Current price: 1.001 USD
         Source: TonSwap (2026-06-15 07:12 UTC)
         Add to your watchlist?
         [Add with defaults]   [Customize alerts]   [Cancel]

User:    [taps Add with defaults]
Bot:     Added jUSDT to your watchlist.
         Default alerts: ±5% over 60m.
         [Open watchlist]   [Add another]
```

`Customize alerts` opens the per-watch settings dialog
(§ 4.4). If the contract cannot be resolved, the bot replies with
the reason (unknown contract / network / not a jetton) and a single
`Try a different address` button.

### 4.3 Watchlist (`/list`)

```
Bot:     Your watchlist (3):
         • TON    — 2.143 USD  +1.4% (1h)  −0.8% (24h)
         • jUSDT  — 1.001 USD  +0.0% (1h)  −0.0% (24h)
         • NOT    — 0.012 USD  −3.2% (1h)  +5.1% (24h)
         [TON: Price]   [TON: Settings]   [TON: Remove]
         [jUSDT: Price] [jUSDT: Settings] [jUSDT: Remove]
         [NOT: Price]   [NOT: Settings]   [NOT: Remove]
         [Add token]   [Refresh]
```

`Refresh` re-fetches the prices once and edits the message. `Remove` is
gated by a one-tap confirm dialog: `Confirm remove TON? [Yes] [No]`.

### 4.4 Per-watch alert settings

```
User:    [taps jUSDT: Settings]
Bot:     jUSDT — alert settings
         Absolute threshold: not set
         Percent threshold: 5.0% over 60m
         [Set absolute threshold]   [Clear absolute threshold]
         [Change percent threshold] [Change timeframe]
         [Back to watchlist]

User:    [taps Change percent threshold]
Bot:     Send the new percent (e.g. 2.5).

User:    2.5
Bot:     Percent threshold for jUSDT: 2.5% over 60m.
         [Back to jUSDT settings]
```

Numeric inputs are validated and re-prompted on failure. A bad input
never silently falls back to the previous value.

### 4.5 Daily summary delivery

The alert engine, once per minute, looks for `users` whose local
`summary_time` matches the current minute and who have
`notification_preferences.summary_enabled = true`. It composes a single
message per user (same shape as the on-demand `/summary`) and sends it.

If the user is currently in their quiet hours, the summary is held
in `alerts_outbox` and sent at the end of the quiet window — same
rule as price alerts.

### 4.6 Price alert delivery

When the price poller crosses a threshold for a `Watch`, the alert
engine enqueues an `AlertEvent` and a message in `alerts_outbox`. The
message format:

```
🚨 jUSDT crossed 1.05 USD
1.062 USD  (+0.012 USD, +1.1%)
Source: TonSwap · 2026-06-15 07:42 UTC
[View token]   [Snooze 1h]
```

`Snooze 1h` sets `watches.cooldown_until = now + 1h` for that user /
token pair. The next button `View token` runs `/price <contract>` for
that token.

Quiet hours: alerts scheduled during a quiet window are queued and
flushed at `quiet_hours_end`. The first such alert is preceded by a
banner: `You have 3 alerts from your quiet hours:`.

### 4.7 Admin reports (`/admin_stats`, `/admin_alerts`)

```
Bot:     Admin stats (last 24h)
         Users:        1,284
         Active watches: 4,915
         Alerts sent:  9,332
         Top tokens (alerts):
           1. jUSDT  — 2,140
           2. NOT    — 1,820
           3. TON    — 1,108
         [More on /admin_alerts 24h]   [Export users]
```

Source outages are pushed automatically as a one-off message into the
admin chat, with a single `Acknowledge` button bound to
`/admin_alerts_ack <event_id>`.

## 5. Anti-spam rules (single source of truth)

| Rule | Default | Where it lives |
|---|---|---|
| Cooldown after any alert on a `(user, token)` | 60 min | `watches.cooldown_until` |
| Hysteresis band around a triggered threshold | 0.5% | alert engine constant |
| Quiet hours | 23:00–07:00 local | `users.quiet_hours_*` |
| Daily summary time | 08:00 local | `users.summary_time` |
| Polling interval | 60 s | price poller constant |

`/settings` exposes every user-visible knob above. Defaults match
`docs/general.md`.

## 6. Data model recap

The schema in `docs/general.md` (Core Entities) is the canonical data
model. This design adds exactly one table beyond it:

- **`alerts_outbox`** — `(id, user_id, chat_id, kind, payload_json, due_at, state, attempts, last_error)`
  — the queue the alert engine drains. `state ∈ {pending, sent, failed}`.

No other additions. The six tables from `general.md` plus this one are
the whole persistence layer.

## 7. Out of scope

- No on-chain wallet / transfer / liquidity alerts.
- No payments.
- Non-USD quotes are not supported.
- No portfolio P&L tracking.
- No web or mobile UI; Telegram is the only client.
- No real-time streaming; the 60 s poll is the source of truth.
