# TonWatchBot — GENERAL Design Document

## Summary
TonWatchBot is a Telegram bot that enables users to privately monitor TON and jetton prices via contract addresses, receiving non-spammy alerts for absolute price thresholds, percentage movements over configurable timeframes, and optional daily summaries. Users customize watchlists, set quiet hours, and adjust notification preferences. The bot owner receives aggregated admin reports (user stats, alert frequency, token activity) in a dedicated Telegram chat. Designed for retail TON/jetton holders needing actionable price notifications and admins seeking operational insights.

## Core Entities
- **User**  
  - `telegram_chat_id` (PK)  
  - `timezone` (required)  
  - `quiet_hours_start` (default 23:00)  
  - `quiet_hours_end` (default 07:00)  
  - `summary_time` (default 08:00)  
  - `notification_preferences` (JSON: summary_enabled, alert_types)  

- **Token**  
  - `contract_address` (PK)  
  - `symbol` (e.g., TON, USDT)  
  - `name` (e.g., "Toncoin", "Wrapped Tether")  
  - `decimals` (integer)  
  - `metadata_source` (e.g., "TonSwap", "The Graph")  

- **Watch**  
  - `user_id` (FK to User)  
  - `token_id` (FK to Token)  
  - `enabled` (boolean)  
  - `price_threshold_usd` (nullable)  
  - `percent_threshold` (nullable, e.g., 5.0)  
  - `percent_timeframe_minutes` (default 60)  
  - `last_alert_state` (JSON: last_price, last_percent_change)  
  - `cooldown_until` (timestamp)  

- **PriceSample**  
  - `token_id` (FK to Token)  
  - `timestamp` (indexed)  
  - `price_usd` (numeric)  
  - `source` (e.g., "TonSwap", "CoinGecko")  

- **AlertEvent**  
  - `user_id` (FK to User)  
  - `token_id` (FK to Token)  
  - `type` (enum: price/percent/summary)  
  - `fired_at` (timestamp)  
  - `payload` (JSON: current_price, delta_usd, delta_percent, timeframe)  

- **AdminRecord**  
  - `token_id` (FK to Token)  
  - `alert_count` (counter)  
  - `last_alert_time` (timestamp)  
  - `user_count` (aggregated)  

**Relationships**  
- One-to-many: User → Watch (user_id)  
- One-to-many: Token → Watch (token_id)  
- One-to-many: Token → PriceSample (token_id)  
- Many-to-one: AlertEvent → User/Token  
- Many-to-one: AdminRecord → Token  

## External Dependencies
- **Telegram Bot API**  
  - Inline buttons, commands, message scheduling, user authentication  
- **Primary Price Sources**  
  - TonSwap API (TON/jetton DEX prices)  
  - The Graph (jetton pool data)  
- **Fallback Price Source**  
  - CoinGecko API (TON/USD only)  
- **Persistence**  
  - PostgreSQL tables: `users`, `tokens`, `watches`, `price_samples`, `alert_events`, `admin_records`  
  - TTL job for `price_samples`: 48h raw data, 90d hourly aggregates  

## Full Feature List
- **User Onboarding**  
  - `/start`: Collect timezone (manual selection or string input), suggest quiet hours/summary defaults  
- **Token Management**  
  - `/add`: Validate contract address via on-chain lookup (TonSwap/The Graph) → inline confirmation  
  - `/remove`: Display watchlist with inline "Remove" buttons  
  - `/list`: List watched tokens with quick actions (Price/Remove/Settings)  
- **Price Queries**  
  - `/price <contract>`: Show current USD price, 1h/24h changes, sample source/timestamp  
  - `/summary`: On-demand daily-style summary of all watched tokens  
- **Alert Configuration**  
  - `/settings`: Configure timezone, quiet hours, summary time, default percent threshold/timeframe  
  - Per-token alert overrides for price thresholds and percent/timeframe  
- **Alert Detection**  
  - Absolute-price triggers: Notify when price crosses user-defined USD threshold  
  - Percent-move triggers: Notify when price change exceeds threshold over timeframe (default 5% in 60m)  
  - Daily summary at user's local `summary_time` (default 08:00)  
- **Anti-Spam Logic**  
  - Cooldown (60m default) after alert to prevent rapid-fire notifications  
  - Hysteresis (0.5% default) to avoid oscillation-triggered spam  
  - Queue alerts during quiet hours for post-quiet delivery (configurable)  
- **Admin Controls**  
  - `/admin_stats`: Show total users, active watches, 24h alert counts  
  - `/admin_users`: Paginated list of users (chat ID + metadata)  
  - `/admin_alerts <period>`: Top tokens by alert frequency, recent alert logs  
  - `/admin_export <period>`: CSV export of user data or alerts  
  - Admin alerts for source outages (>5m), queue backlogs, or fatal errors  

## Non-Goals
- No on-chain wallet/transfer/liquidity alerts (price-only focus)  
- No payment/monetization features  
- No support for non-USD quotes (e.g., EUR)  
- No portfolio position tracking or custody management  
- No web/mobile UI beyond Telegram commands/buttons  
- No real-time market data (60s polling interval is sufficient)