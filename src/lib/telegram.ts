// Alerts and the daily digest go to one Telegram chat (a private chat or the family group).
// Create a bot with @BotFather, add it to the chat, then set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.

export function telegramConfigured(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/**
 * Send a plain-text message. Never throws: a notification failure must not break the job that raised it.
 * `silent` delivers without sound (Telegram's disable_notification).
 */
export async function sendTelegram(text: string, opts: { silent?: boolean } = {}): Promise<boolean> {
  if (!telegramConfigured()) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        disable_notification: !!opts.silent,
        link_preview_options: { is_disabled: true },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // The URL carries the bot token, so log Telegram's answer, never the request.
      console.warn(`[telegram] ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[telegram] send failed:", (e as Error).message);
    return false;
  }
}
