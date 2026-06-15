# TonWatchBot — Details Spec

Concrete per-command behaviour, data side-effects, and error handling.
Consistent with `docs/design.md`. This document is the contract the
Dev-phase tasks are built against; it is not shipped to end users.

## 0. Conventions

- All times in DB are UTC. All times shown to users are converted from
  UTC to `users.timezone` before formatting.
- All money in messages is USD with two decimal places, e.g. `1.05 USD`.
  Internal `price_usd` is `numeric(18,8)`.
- All percentage values are formatted with one decimal place unless the
  value is `< 0.1%`, in which case two decimal places are used.
- Inline-button `callback_data` is namespaced: `<surface>:<verb>:<id>`,
  e.g. `watch:remove:EQBicq…`, `add:confirm:EQBicq…`, `settings:tz:Europe/Berlin`.
- `ctx.session` is a `Map`-style store. Dialog steps are stored under
  `ctx.session.dialog`. Any handler that mutates the dialog MUST clear
  it (`ctx.session.dialog = undefined`) before returning in success or
  cancel paths.
- The bot reads the admins allowlist from `process.env.ADMIN_CHAT_IDS`
  (comma-separated numeric chat IDs). No DB table for admins.

## 1. Onboarding

### 1.1 `/start`

- **Trigger:** `message.text === "/start"` from a user with no row in
  `users`.
- **Side effect:** `INSERT INTO users (telegram_chat_id) VALUES ($1)`
  with all other columns at their schema defaults
  (`timezone = NULL`, `quiet_hours_start = '23:00'`,
  `quiet_hours_end = '07:00'`, `summary_time = '08:00'`,
  `notification_preferences = {"summary_enabled": true,
  "alert_types": ["price", "percent"]}`).
- **Reply:** welcome text + timezone inline keyboard (see design § 4.1).
- **Session:** `ctx.session.dialog = { kind: "onboarding", step: "tz" }`.
- **Errors:** none expected (idempotent insert via `ON CONFLICT DO NOTHING`).

### 1.2 Timezone selection callback

- **Trigger:** `callback_query.data` matches `tz:select:<IANA>`.
- **Validation:** IANA string is validated with `Intl.DateTimeFormat`.
  Invalid values reply with a one-line error and re-render the menu.
- **Side effect:** `UPDATE users SET timezone = $1 WHERE telegram_chat_id = $2`.
- **Reply:** edit original message to "Timezone set: …" + quiet/summary
  defaults menu (design § 4.1).
- **Session:** `dialog.step = "defaults"`.

### 1.3 Manual timezone entry

- **Trigger:** `callback_query.data === "tz:manual"` then the next
  `message.text` from the same user.
- **Validation:** IANA string.
- **Side effect:** same as 1.2.
- **Session:** cleared after success.
- **Errors:** invalid string → reply "Unknown timezone, try again" and
  keep `dialog.step = "tz_manual"`. The Cancel button always works.

### 1.4 Keep defaults

- **Trigger:** `callback_query.data === "defaults:keep"`.
- **Side effect:** none (defaults are already on the row).
- **Session:** cleared.
- **Reply:** "All set. Try /add <contract> …".

### 1.5 Existing-user `/start`

- If a `users` row already exists, reply "Welcome back." and redraw
  the watchlist (same as `/list`).

## 2. Watchlist

### 2.1 `/add <contract>`

- **Trigger:** `message.text` starts with `/add `.
- **Arg parsing:** trim everything after `/add `, single space-separated
  token. Empty arg → reply "Usage: /add <contract>".
- **Validation pipeline (in order):**
  1. Address shape — 48 chars, base64url alphabet, EQ / UQ / raw form.
     On fail: `Invalid address format.`
  2. Resolve via `prices.resolveToken(contract)` — calls TonSwap first,
     The Graph second. Returns `{symbol, name, decimals, price_usd,
     source, sampled_at}` or throws.
  3. On `TokenNotFound` → `Could not find that contract. Check the
     address and try again.`
  4. On any other resolver error → `Price source unavailable. Try
     again in a minute.`
- **Side effects on success:**
  - `INSERT INTO tokens (…) ON CONFLICT (contract_address) DO UPDATE
    SET symbol = EXCLUDED.symbol, name = EXCLUDED.name, decimals =
    EXCLUDED.decimals`.
  - `INSERT INTO watches (user_id, token_id, enabled = true,
    percent_threshold = <user default>, percent_timeframe_minutes =
    <user default>)` — only if no existing `Watch` row for
    `(user_id, token_id)`.
- **Reply:** confirmation card with inline buttons
  `add:confirm:<contract>`, `add:customize:<contract>`, `cancel:<opaque>`.
- **Session:** `dialog = { kind: "add_confirm", contract }`.
- **Confirm button:**
  - Side effect: finalise the watch row insert (no-op if already
    inserted on validation).
  - Reply: edit message to "Added <symbol> to your watchlist." +
    `Open watchlist` / `Add another` buttons.
  - Session: cleared.
- **Customize button:** open per-watch settings dialog (§ 5).
- **Cancel button:** clear dialog, reply "Cancelled."

### 2.2 `/remove`

- **Trigger:** command, no args.
- **Behaviour:** render the watchlist as inline buttons,
  one `watch:remove:<token_id>` per row + a single `Cancel`.
- **Remove button:**
  - `dialog = { kind: "remove_confirm", token_id }`.
  - Edit message to `Remove <symbol> from your watchlist?` +
    `Remove:yes:<token_id>` / `Remove:no`.
- **Confirm yes:** `DELETE FROM watches WHERE user_id = $1 AND
  token_id = $2`. Edit message to "Removed <symbol>." If the watchlist
  is now empty, append "Add one with /add <contract>." Clear session.
- **Confirm no:** clear session, edit message to "Cancelled."

### 2.3 `/list`

- **Trigger:** command, no args.
- **Behaviour:** for the user, fetch every enabled watch with its token
  and the latest `PriceSample`. For each row, build a card line
  (`<symbol> — <price> USD  <1h %>  <24h %>`) and three buttons
  (`price:show:<token_id>`, `watch:settings:<token_id>`,
  `watch:remove:<token_id>`). Append a footer row
  (`Add token` → opens `/add` flow with empty arg, `Refresh` →
  re-renders with fresh prices).
- **Refresh button:** `callback_query.data === "list:refresh"`. Re-run
  the same query and `editMessageText` the same message in place.
  Stale timestamps in the body (older than 5 minutes) are highlighted
  with a "stale" suffix on the line.
- **Empty watchlist reply:** "You're not watching any tokens yet.
  /add <contract> to start."

## 3. Price

### 3.1 `/price <contract>`

- **Trigger:** command, optional single arg.
- **Empty arg:** reply "Usage: /price <contract>".
- **Validation:** same shape check as `/add`. On fail: `Invalid
  address format.`
- **Resolution:** `prices.resolveToken(contract)`. If the token is not
  in the local `tokens` table yet, treat the resolution failure as
  "unknown contract" → `Could not find that contract.`
- **Side effect:** none.
- **Reply:** card with `<symbol> — <price> USD`, `1h <%>`, `24h <%>`,
  `Source: <source> · <UTC HH:MM>`, and a single `Add to watchlist`
  button that opens the `/add` flow with the contract pre-filled. If
  the user already has a `Watch` for this token, the button reads
  `Already in your watchlist` and is non-clickable.

## 4. Summary

### 4.1 `/summary` (on-demand)

- **Trigger:** command, no args.
- **Behaviour:** identical body to the daily summary (4.2) but
  `Source: on-demand · <UTC HH:MM>`. No `alerts_outbox` row is created.
- **Empty watchlist reply:** same as 2.3.

### 4.2 Daily summary delivery (scheduled)

- **Schedule:** every minute, the alert engine selects
  `users WHERE timezone IS NOT NULL AND summary_time = $now_local AND
  notification_preferences->>'summary_enabled' = 'true'`.
- **Per user:** compose the summary card (same shape as 4.1) and insert
  one `alerts_outbox` row with `kind = 'summary'`, `due_at = now()`. The
  alert engine then drains it under the same quiet-hours rules as price
  alerts (design § 5).
- **Side effect:** `alerts_outbox` row.
- **Quiet hours:** the summary is held in the outbox and flushed at
  `quiet_hours_end`. A queued summary is never duplicated; if the user
  runs `/summary` manually while a queued one exists, the manual reply
  is sent immediately and the queued row is deleted (the user already
  saw it).

## 5. Settings

### 5.1 `/settings`

- **Trigger:** command, no args.
- **Reply:** main settings menu. Buttons:
  `settings:tz`, `settings:quiet`, `settings:summary`,
  `settings:defpct`, `settings:deftime`. Each opens a sub-dialog.
  The current value is shown next to each label.

### 5.2 Timezone sub-dialog

- **Trigger:** `settings:tz`.
- **Behaviour:** re-render the timezone picker (same as 1.2). Update
  `users.timezone` on selection. Session:
  `dialog = { kind: "settings_tz" }`.

### 5.3 Quiet hours sub-dialog

- **Trigger:** `settings:quiet`.
- **Reply:** "Send the quiet hours as `HH:MM HH:MM` (e.g. `23:00 07:00`)."
  Buttons: `Cancel`.
- **Input handler:** parse two `HH:MM` strings. Both must be valid 24h
  times. On parse fail: re-prompt with the same message. On valid input:
  `UPDATE users SET quiet_hours_start = $1, quiet_hours_end = $2`.
  Clear session.
- **Session:** `dialog = { kind: "settings_quiet" }`.

### 5.4 Summary time sub-dialog

- **Trigger:** `settings:summary`.
- **Reply:** "Send the summary time as `HH:MM` in your local time."
- **Input handler:** parse one `HH:MM`. Update `users.summary_time`.
  Clear session.

### 5.5 Default percent threshold

- **Trigger:** `settings:defpct`.
- **Reply:** "Send the default percent threshold (e.g. `2.5`)."
- **Input handler:** parse positive float. On parse fail: re-prompt.
  Update
  `users.notification_preferences = jsonb_set(notification_preferences,
  '{default_percent_threshold}', $1::text::jsonb)`. Clear session.

### 5.6 Default percent timeframe

- **Trigger:** `settings:deftime`.
- **Reply:** "Send the default timeframe in minutes (e.g. `60`)."
- **Input handler:** parse positive int between `5` and `1440`. Update
  `users.notification_preferences->'default_percent_timeframe_minutes'`.
  Clear session.

### 5.7 Per-watch settings

- **Trigger:** `watch:settings:<token_id>` from the watchlist.
- **Reply:** card with current `price_threshold_usd`,
  `percent_threshold`, `percent_timeframe_minutes` for that watch.
  Buttons: `watch:set_abs:<token_id>`, `watch:clear_abs:<token_id>`,
  `watch:set_pct:<token_id>`, `watch:set_time:<token_id>`,
  `Back to watchlist`.
- **Set absolute threshold:** dialog `kind: "watch_abs"`, single next
  message must be a positive decimal USD value. Update
  `watches.price_threshold_usd = $1`. Clear session.
- **Clear absolute threshold:** `watches.price_threshold_usd = NULL`.
  No dialog.
- **Set percent threshold:** dialog `kind: "watch_pct"`, single next
  message must be a positive float. Update `watches.percent_threshold`.
- **Set timeframe:** dialog `kind: "watch_time"`, single next message
  must be int `5..1440`. Update `watches.percent_timeframe_minutes`.
- **Errors:** any failed parse re-prompts with the same message and
  keeps the dialog open.

## 6. Anti-spam rules

These are enforced inside the alert engine, not at the Telegram layer.

| Rule | Default | Field |
|---|---|---|
| Cooldown after any alert on a `(user, token)` | 60 min | `watches.cooldown_until` |
| Hysteresis band around a triggered threshold | 0.5% | code constant |
| Quiet hours | 23:00–07:00 local | `users.quiet_hours_*` |
| Daily summary time | 08:00 local | `users.summary_time` |
| Polling interval | 60 s | code constant |

### 6.1 Snooze

- The `Snooze 1h` button in an alert message
  (`callback_query.data === "alert:snooze:60"`) sets
  `watches.cooldown_until = now() + interval '1 hour'` for that
  `(user_id, token_id)` pair. Always allowed, even outside quiet
  hours.

## 7. Admin commands

All admin handlers run through a guard middleware that returns
silently if `ctx.from.id` is not in `ADMIN_CHAT_IDS`.

### 7.1 `/admin_stats`

- **Side effect:** none.
- **Reply:** card with
  - `SELECT count(*) FROM users`,
  - `SELECT count(*) FROM watches WHERE enabled = true`,
  - `SELECT count(*) FROM alert_events WHERE fired_at > now() - interval '24 hours'`,
  - top 5 tokens by alert count in last 24h.

### 7.2 `/admin_users [page]`

- **Arg:** optional 1-based page number. Default 1. Page size 20.
- **Reply:** numbered list of `(telegram_chat_id, timezone,
  watch_count, last_activity_at)`. Footer: `Prev` / `Next` buttons
  (`admin_users:page:<n>`). Empty result: "No users."

### 7.3 `/admin_alerts <24h|7d|30d>`

- **Arg:** one of `24h`, `7d`, `30d`. Default `24h`. Invalid arg: print
  the usage line.
- **Reply:** two sections.
  - Top tokens: top 10 by `count(alert_events)` in the period with
    alert count and unique-user count.
  - Recent log: the 20 most recent `alert_events` rows, one line each:
    `<UTC HH:MM> <symbol> <type> <chat_id>`.

### 7.4 `/admin_export <users|alerts> <period>`

- **Arg 1:** `users` or `alerts`. **Arg 2:** `24h` / `7d` / `30d`.
- **Reply:** `sendDocument` with a CSV file:
  - `users_<period>.csv`: `chat_id,timezone,quiet_start,quiet_end,
    summary_time,watch_count,last_activity_at`.
  - `alerts_<period>.csv`: `fired_at,symbol,type,chat_id,payload_json`.
- **Limits:** hard cap 10,000 rows. If the underlying query would
  return more, the reply is a card `Result too large; narrow the
  period.` with no file.

### 7.5 Source outage admin alerts

- The price poller tracks per-source last-success timestamps in
  memory. If a source has not succeeded for `> 5 minutes` and no
  unacknowledged `admin_alert` exists for that source, the alert
  engine inserts one row into `admin_records` and sends a message to
  every admin chat:
  - `<source> unreachable for <mm>m. Last success: <UTC HH:MM>.`
  - Button: `Acknowledge:source_outage:<source>`.
- The matching callback deletes the open `admin_records` row and
  edits the message to "Acknowledged.".

## 8. Generic handlers

### 8.1 Unknown command

- Trigger: any `message.text` starting with `/` that does not match a
  registered command.
- Reply: `Unknown command. Try /help.`

### 8.2 Non-command text outside dialog

- Trigger: any `message.text` not starting with `/` and the session
  has no active `dialog`.
- Reply: silent (no message sent).

### 8.3 Non-command text inside dialog

- Handled by the active dialog's input handler. See 1.3, 5.3–5.6, 5.7.

### 8.4 Foreign callback

- Trigger: `callback_query` whose `data` is not in the registered set
  for the current user.
- Reply: `answerCallbackQuery({ text: "Not yours", show_alert: true })`.

### 8.5 Cancel button

- Trigger: `callback_query.data === "cancel"`.
- Side effect: `ctx.session.dialog = undefined`.
- Reply: edit message to "Cancelled." and redraw the previous menu
  (settings if there was a settings dialog, watchlist otherwise).

## 9. Data side-effect summary

Per request:

| Command | Tables touched | Out-of-band |
|---|---|---|
| `/start` (first) | `users` INSERT | — |
| `/start` (existing) | none | — |
| `/add` | `tokens` UPSERT, `watches` INSERT | `prices.resolveToken` |
| `/add` confirm | none (or INSERT if not pre-inserted) | — |
| `/remove` | `watches` DELETE | — |
| `/list` | none | `prices.latest` |
| `/list` refresh | none | `prices.latest` |
| `/price` | none | `prices.resolveToken` |
| `/summary` | none | `prices.latest` |
| `/settings` * | `users` UPDATE | — |
| per-watch settings * | `watches` UPDATE | — |
| daily summary delivery | `alerts_outbox` INSERT | `prices.latest` |
| price alert (outbox drain) | `alerts_outbox` UPDATE, `watches` UPDATE (cooldown), `alert_events` INSERT | `sendMessage` |
| Snooze | `watches` UPDATE | — |
| `/admin_stats` | none | — |
| `/admin_users` | none | — |
| `/admin_alerts` | none | — |
| `/admin_export` | none | `sendDocument` |
| source outage | `admin_records` INSERT | `sendMessage` |
| outage ack | `admin_records` DELETE | `editMessageText` |

## 10. Out of scope (carried over from `docs/general.md`)

- No on-chain wallet / transfer / liquidity alerts.
- No payments.
- Non-USD quotes not supported.
- No portfolio P&L tracking.
- No web or mobile UI; Telegram is the only client.
- No real-time streaming; 60 s poll is the source of truth.
