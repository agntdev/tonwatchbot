// Per-chat session scratch. Multi-step dialog flows register a `dialog`
// shape here; the authoritative user state lives in the store (users table
// + dialog fields per docs/details.md §0).
//
// Keep this flat and serializable. The toolkit's MemorySessionStorage uses a
// Map under the hood; restarting the process wipes all sessions, which is
// fine for dev / harness. Production swaps in SQLite (same interface).

export type DialogState =
  | { kind: "onboarding"; step: "tz" | "tz_manual" | "defaults" }
  | { kind: "onboarding_quiet" }
  | { kind: "onboarding_summary" }
  | { kind: "settings_tz" }
  | { kind: "settings_quiet" }
  | { kind: "settings_summary" }
  | { kind: "settings_defpct" }
  | { kind: "settings_deftime" }
  | { kind: "add_confirm"; contract: string }
  | { kind: "remove_confirm"; tokenId: string }
  | { kind: "watch_abs"; tokenId: string; chain?: boolean }
  | { kind: "watch_pct"; tokenId: string; chain?: boolean }
  | { kind: "watch_time"; tokenId: string; chain?: boolean };

export interface Session {
  /** Currently-active dialog state. undefined = no active dialog. */
  dialog?: DialogState;
}
