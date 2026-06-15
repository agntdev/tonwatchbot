// /start command + the onboarding dialog (docs/details.md §1, design §4.1).
//
// Replaces the F01 placeholder. On first run, asks for a timezone via
// inline keyboard (common zones + "Enter manually"). Once a timezone is
// set, asks whether to keep the default quiet hours + summary time or
// change them. Subsequent /start calls say "Welcome back." and redraw
// the watchlist footer.

import { inlineButton, inlineKeyboard, menuKeyboard } from "@agntdev/bot-toolkit";
import type { Bot } from "grammy";
import type { Ctx } from "../bot.js";
import { formatHHMM, parseHHMM } from "../config.js";
import type { Store } from "../store.js";

const COMMON_TIMEZONES: ReadonlyArray<{ label: string; iana: string }> = [
  { label: "Europe/London", iana: "Europe/London" },
  { label: "Europe/Berlin", iana: "Europe/Berlin" },
  { label: "America/New_York", iana: "America/New_York" },
  { label: "America/Los_Angeles", iana: "America/Los_Angeles" },
  { label: "Asia/Singapore", iana: "Asia/Singapore" },
  { label: "Asia/Tokyo", iana: "Asia/Tokyo" },
];

function timezoneKeyboard(): ReturnType<typeof menuKeyboard> {
  return menuKeyboard(
    COMMON_TIMEZONES.map((t) => ({ text: t.label, data: `tz:select:${t.iana}` })).concat([
      { text: "Enter manually…", data: "tz:manual" },
      { text: "Cancel", data: "cancel" },
    ]),
  );
}

function isValidIana(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function defaultsKeyboard(): ReturnType<typeof inlineKeyboard> {
  return inlineKeyboard([
    [inlineButton("Keep defaults", "defaults:keep")],
    [inlineButton("Change quiet hours", "onb:quiet")],
    [inlineButton("Change summary time", "onb:summary")],
    [inlineButton("Cancel", "cancel")],
  ]);
}

function parseQuiet(input: string): { start: string; end: string } | null {
  const parts = input.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const a = parseHHMM(parts[0]!);
  const b = parseHHMM(parts[1]!);
  if (a === null || b === null) return null;
  return { start: parts[0]!, end: parts[1]! };
}

function formatSummaryTime(input: string): string | null {
  const m = parseHHMM(input.trim());
  if (m === null) return null;
  return formatHHMM(m);
}

async function applyTimezone(ctx: Ctx, store: Store, tz: string): Promise<void> {
  store.updateUser(ctx.from!.id, { timezone: tz });
  const user = store.getOrCreateUser(ctx.from!.id);
  ctx.session.dialog = { kind: "onboarding", step: "defaults" };
  await ctx.reply(
    `Timezone set: ${tz}.\n` +
      `Quiet hours default to ${user.quietHoursStart}–${user.quietHoursEnd}.\n` +
      `Daily summary at ${user.summaryTime}.`,
    { reply_markup: defaultsKeyboard() },
  );
}

export function registerStart(bot: Bot<Ctx>, store: Store): void {
  // ── /start ────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    const user = store.getOrCreateUser(ctx.from!.id);
    if (user.timezone !== null) {
      await ctx.reply("Welcome back.", {
        reply_markup: inlineKeyboard([[inlineButton("Open watchlist", "list:show")]]),
      });
      return;
    }
    await ctx.reply(
      "Welcome to TonWatchBot! 👋\n" +
        "To send alerts at the right time, pick your timezone:",
      { reply_markup: timezoneKeyboard() },
    );
    ctx.session.dialog = { kind: "onboarding", step: "tz" };
  });

  // ── tz selection (button tap) ─────────────────────────────────────────
  bot.callbackQuery(/^tz:select:(.+)$/, async (ctx) => {
    const tz = ctx.match[1]!;
    if (!isValidIana(tz)) {
      await ctx.answerCallbackQuery({ text: "Unknown timezone" });
      return;
    }
    await ctx.answerCallbackQuery();
    await applyTimezone(ctx, store, tz);
  });

  bot.callbackQuery("tz:manual", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Send your IANA timezone, e.g. `Europe/Berlin` or `America/Chicago`.");
    ctx.session.dialog = { kind: "onboarding", step: "tz_manual" };
  });

  // ── defaults menu choices ────────────────────────────────────────────
  bot.callbackQuery("defaults:keep", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.dialog = undefined;
    await ctx.reply("All set. Try /add <contract> to watch a token, or /help for the full command list.");
  });

  bot.callbackQuery("onb:quiet", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Send the quiet hours as `HH:MM HH:MM` (e.g. `23:00 07:00`).");
    ctx.session.dialog = { kind: "onboarding_quiet" };
  });

  bot.callbackQuery("onb:summary", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Send the summary time as `HH:MM` in your local time.");
    ctx.session.dialog = { kind: "onboarding_summary" };
  });

  // ── cancel ────────────────────────────────────────────────────────────
  bot.callbackQuery("cancel", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    ctx.session.dialog = undefined;
    await ctx.editMessageText("Cancelled.");
  });
}

/** Handle a non-command text message that arrives while an onboarding
 *  dialog is active. Returns true if the message was handled. */
export async function handleOnboardingText(ctx: Ctx, store: Store): Promise<boolean> {
  const d = ctx.session.dialog;
  if (!d) return false;
  const user = store.getOrCreateUser(ctx.from!.id);
  const text = ctx.message?.text?.trim();
  if (!text) return false;

  if (d.kind === "onboarding" && d.step === "tz_manual") {
    if (!isValidIana(text)) {
      await ctx.reply("Unknown timezone, try again (e.g. `Europe/Berlin`).");
      return true;
    }
    await applyTimezone(ctx, store, text);
    return true;
  }
  if (d.kind === "onboarding_quiet") {
    const parsed = parseQuiet(text);
    if (!parsed) {
      await ctx.reply("Bad format. Send two times as `HH:MM HH:MM`.");
      return true;
    }
    store.updateUser(user.telegramChatId, {
      quietHoursStart: parsed.start,
      quietHoursEnd: parsed.end,
    });
    ctx.session.dialog = undefined;
    await ctx.reply(`Quiet hours set to ${parsed.start}–${parsed.end}.`);
    return true;
  }
  if (d.kind === "onboarding_summary") {
    const formatted = formatSummaryTime(text);
    if (!formatted) {
      await ctx.reply("Bad time. Send `HH:MM` in 24h format.");
      return true;
    }
    store.updateUser(user.telegramChatId, { summaryTime: formatted });
    ctx.session.dialog = undefined;
    await ctx.reply(`Summary time set to ${formatted}.`);
    return true;
  }
  return false;
}
