// Middleware. Currently: an admin allowlist guard that drops any
// /admin_* command sent by a chat id not in the configured allowlist.
// All other middleware (session, error boundary) is wired by `createBot`.

import type { BotConfig } from "./config.js";
import type { Ctx } from "./bot.js";

export function adminOnly(cfg: BotConfig) {
  return async (ctx: Ctx, next: () => Promise<void>): Promise<void> => {
    const text = ctx.message?.text ?? "";
    if (!text.startsWith("/admin_")) return next();
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!cfg.adminChatIds.includes(chatId)) {
      // Silently drop — the design says return silently for non-admins.
      return;
    }
    return next();
  };
}
