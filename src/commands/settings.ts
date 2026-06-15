// /settings command + sub-dialogs (docs/details.md §5).
//
// /settings opens a main menu with five sub-dialogs: timezone, quiet hours,
// summary time, default percent threshold, default percent timeframe. Each
// sub-dialog uses a text-input handler in the same way the onboarding flow
// does. Input validation is centralised here.

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

function isValidIana(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function mainMenuKeyboard(current: { tz: string | null; quiet: string; summary: string; defpct: number; deftime: number }): ReturnType<typeof inlineKeyboard> {
  return inlineKeyboard([
    [inlineButton(`Timezone: ${current.tz ?? "not set"}`, "settings:tz")],
    [inlineButton(`Quiet hours: ${current.quiet}`, "settings:quiet")],
    [inlineButton(`Summary time: ${current.summary}`, "settings:summary")],
    [inlineButton(`Default percent: ${current.defpct}%`, "settings:defpct")],
    [inlineButton(`Default timeframe: ${current.deftime} min`, "settings:deftime")],
    [inlineButton("Cancel", "cancel")],
  ]);
}

function timezonePicker(): ReturnType<typeof menuKeyboard> {
  return menuKeyboard(
    COMMON_TIMEZONES.map((t) => ({ text: t.label, data: `tz:select:${t.iana}` })).concat([
      { text: "Enter manually…", data: "tz:manual" },
      { text: "Cancel", data: "cancel" },
    ]),
  );
}

function parseQuiet(input: string): { start: string; end: string } | null {
  const parts = input.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const a = parseHHMM(parts[0]!);
  const b = parseHHMM(parts[1]!);
  if (a === null || b === null) return null;
  return { start: parts[0]!, end: parts[1]! };
}

export function registerSettings(bot: Bot<Ctx>, store: Store): void {
  // ── /settings ─────────────────────────────────────────────────────────
  bot.command("settings", async (ctx) => {
    const u = store.getOrCreateUser(ctx.from!.id);
    await ctx.reply(
      "Settings:",
      { reply_markup: mainMenuKeyboard({
        tz: u.timezone,
        quiet: `${u.quietHoursStart}–${u.quietHoursEnd}`,
        summary: u.summaryTime,
        defpct: u.notificationPreferences.defaultPercentThreshold,
        deftime: u.notificationPreferences.defaultPercentTimeframeMinutes,
      }) },
    );
  });

  // ── settings:tz → timezone picker ────────────────────────────────────
  bot.callbackQuery("settings:tz", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.dialog = { kind: "settings_tz" };
    await ctx.reply("Pick a timezone:", { reply_markup: timezonePicker() });
  });

  // ── settings:quiet ────────────────────────────────────────────────────
  bot.callbackQuery("settings:quiet", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.dialog = { kind: "settings_quiet" };
    await ctx.reply("Send the quiet hours as `HH:MM HH:MM` (e.g. `23:00 07:00`).");
  });

  // ── settings:summary ──────────────────────────────────────────────────
  bot.callbackQuery("settings:summary", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.dialog = { kind: "settings_summary" };
    await ctx.reply("Send the summary time as `HH:MM` in your local time.");
  });

  // ── settings:defpct ───────────────────────────────────────────────────
  bot.callbackQuery("settings:defpct", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.dialog = { kind: "settings_defpct" };
    await ctx.reply("Send the default percent threshold (e.g. `2.5`).");
  });

  // ── settings:deftime ──────────────────────────────────────────────────
  bot.callbackQuery("settings:deftime", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.dialog = { kind: "settings_deftime" };
    await ctx.reply("Send the default timeframe in minutes (e.g. `60`).");
  });
}

/** Text-input handler for the settings sub-dialogs. Called from the
 *  bot.ts text router after onboarding's text handler. */
export async function handleSettingsText(ctx: Ctx, store: Store): Promise<boolean> {
  const d = ctx.session.dialog;
  if (!d) return false;
  const user = store.getOrCreateUser(ctx.from!.id);
  const text = ctx.message?.text?.trim();
  if (!text) return false;

  if (d.kind === "settings_tz") {
    // Re-uses the tz:select callback for valid IANA values typed by the
    // user; the keyboard was shown so most users tap a button.
    if (!isValidIana(text)) {
      await ctx.reply("Unknown timezone, try again (e.g. `Europe/Berlin`).");
      return true;
    }
    store.updateUser(user.telegramChatId, { timezone: text });
    ctx.session.dialog = undefined;
    await ctx.reply(`Timezone set: ${text}.`);
    return true;
  }
  if (d.kind === "settings_quiet") {
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
  if (d.kind === "settings_summary") {
    const m = parseHHMM(text);
    if (m === null) {
      await ctx.reply("Bad time. Send `HH:MM` in 24h format.");
      return true;
    }
    store.updateUser(user.telegramChatId, { summaryTime: formatHHMM(m) });
    ctx.session.dialog = undefined;
    await ctx.reply(`Summary time set to ${formatHHMM(m)}.`);
    return true;
  }
  if (d.kind === "settings_defpct") {
    const v = Number(text);
    if (!Number.isFinite(v) || v <= 0) {
      await ctx.reply("Send a positive number, e.g. `2.5`.");
      return true;
    }
    store.updateUser(user.telegramChatId, {
      notificationPreferences: {
        ...user.notificationPreferences,
        defaultPercentThreshold: v,
      },
    });
    ctx.session.dialog = undefined;
    await ctx.reply(`Default percent threshold set to ${v}%.`);
    return true;
  }
  if (d.kind === "settings_deftime") {
    const v = Number(text);
    if (!Number.isInteger(v) || v < 5 || v > 1440) {
      await ctx.reply("Send an integer between 5 and 1440 minutes.");
      return true;
    }
    store.updateUser(user.telegramChatId, {
      notificationPreferences: {
        ...user.notificationPreferences,
        defaultPercentTimeframeMinutes: v,
      },
    });
    ctx.session.dialog = undefined;
    await ctx.reply(`Default timeframe set to ${v} minutes.`);
    return true;
  }
  return false;
}
