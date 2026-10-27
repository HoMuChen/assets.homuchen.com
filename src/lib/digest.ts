import { activeAlerts } from "./alerts";
import { db, type SnapshotRow } from "./db";
import { fmtPct, fmtTwd } from "./format";
import { sendTelegram } from "./telegram";

/**
 * TELEGRAM_DIGEST: what the nightly message after the 23:55 snapshot shows.
 *   pct (default)  changes as percentages only — Telegram chats aren't end-to-end encrypted
 *   full           amounts too
 *   off            no digest (alerts still go out)
 */
export type DigestMode = "off" | "pct" | "full";

export function digestMode(): DigestMode {
  const v = process.env.TELEGRAM_DIGEST;
  return v === "off" || v === "full" ? v : "pct";
}

const PARTS: [string, (s: SnapshotRow) => number][] = [
  ["股票", (s) => s.stocks],
  ["加密貨幣", (s) => s.crypto],
  ["現金", (s) => s.cash],
  ["期貨", (s) => s.tw_futures],
  ["房地產", (s) => s.real_estate - s.mortgage],
];

const mmdd = (date: string) => date.slice(5).replace("-", "/");
const arrow = (n: number) => (n > 0 ? "▲" : n < 0 ? "▼" : "");
const pctOf = (diff: number, base: number) => (base ? (diff / Math.abs(base)) * 100 : null);

export function digestMessage(today: SnapshotRow, prev: SnapshotRow | undefined, mode: "pct" | "full", alertCount = 0): string {
  const lines: string[] = [];
  if (!prev) {
    lines.push(mode === "full" ? `📊 ${mmdd(today.date)} 淨資產 ${fmtTwd(today.net_worth)}` : `📊 ${mmdd(today.date)} 已記錄快照`);
  } else {
    const diff = today.net_worth - prev.net_worth;
    const pct = pctOf(diff, prev.net_worth);
    if (mode === "full") {
      lines.push(`📊 ${mmdd(today.date)} 淨資產 ${fmtTwd(today.net_worth)}`);
      lines.push(`較 ${mmdd(prev.date)} ${arrow(diff)} ${fmtTwd(Math.abs(diff))}${pct != null ? `（${fmtPct(pct)}）` : ""}`);
    } else {
      lines.push(`📊 ${mmdd(today.date)} 淨資產 ${arrow(diff)} ${pct != null ? fmtPct(pct) : "—"}（較 ${mmdd(prev.date)}）`);
    }
    // Categories that moved, biggest move first.
    const moves = PARTS.map(([label, value]) => ({ label, diff: value(today) - value(prev), base: value(prev) }))
      .filter((m) => Math.abs(m.diff) >= 1)
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
      .map((m) => {
        const p = pctOf(m.diff, m.base);
        const amount = mode === "full" ? fmtTwd(Math.abs(m.diff)) : p != null ? fmtPct(Math.abs(p), false) : "新增";
        return `${m.label} ${arrow(m.diff)} ${amount}`;
      });
    if (moves.length) lines.push(moves.join("｜"));
  }
  if (alertCount > 0) lines.push(`⚠️ 目前有 ${alertCount} 個未解除的告警`);
  return lines.join("\n");
}

/** Nightly digest, sent silently; a no-op when TELEGRAM_DIGEST=off or Telegram isn't configured. */
export async function sendDigest(today: SnapshotRow) {
  const mode = digestMode();
  if (mode === "off") return;
  const prev = db().prepare("SELECT * FROM snapshots WHERE date < ? ORDER BY date DESC LIMIT 1").get(today.date) as
    | SnapshotRow
    | undefined;
  await sendTelegram(digestMessage(today, prev, mode, activeAlerts().length), { silent: true });
}
