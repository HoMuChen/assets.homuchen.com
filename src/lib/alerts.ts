import { db, type AlertLevel, type AlertRow } from "./db";
import { sendTelegram } from "./telegram";
import { taipeiParts } from "./time";

/** While an alert stays active it is sent again after this long. */
const RENOTIFY_MS: Record<AlertLevel, number> = { urgent: 30 * 60_000, warning: 12 * 3_600_000 };
const ICON: Record<AlertLevel, string> = { urgent: "🚨", warning: "⚠️" };

/** 00:00–07:00 in Taipei, warnings arrive without sound; urgent alerts always ring. */
const quietHours = (now: Date) => taipeiParts(now).hour < 7;

function getAlert(key: string): AlertRow | undefined {
  return db().prepare("SELECT * FROM alerts WHERE key = ?").get(key) as AlertRow | undefined;
}

export function activeAlerts(): AlertRow[] {
  return db()
    .prepare("SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY level = 'urgent' DESC, opened_at")
    .all() as AlertRow[];
}

export function resolvedSince(since: Date): AlertRow[] {
  return db()
    .prepare("SELECT * FROM alerts WHERE resolved_at >= ? ORDER BY resolved_at DESC")
    .all(since.toISOString()) as AlertRow[];
}

/**
 * Open the alert `key`, or update it if already open. Telegram hears about it when it opens, when it
 * escalates to urgent, and again every RENOTIFY_MS while it lasts. A failed send leaves notified_at
 * as it was, so the next check retries.
 */
export async function raiseAlert(key: string, level: AlertLevel, title: string, detail: string | null, now = new Date()) {
  const iso = now.toISOString();
  const prev = getAlert(key);
  const wasActive = !!prev && prev.resolved_at == null;
  db()
    .prepare(
      `INSERT INTO alerts (key, level, title, detail, opened_at, updated_at) VALUES (@key, @level, @title, @detail, @iso, @iso)
       ON CONFLICT(key) DO UPDATE SET level = excluded.level, title = excluded.title, detail = excluded.detail,
         updated_at = excluded.updated_at,
         opened_at = CASE WHEN alerts.resolved_at IS NULL THEN alerts.opened_at ELSE excluded.opened_at END,
         notified_at = CASE WHEN alerts.resolved_at IS NULL THEN alerts.notified_at END,
         resolved_at = NULL`,
    )
    .run({ key, level, title, detail, iso });

  const lastSent = wasActive && prev.notified_at ? Date.parse(prev.notified_at) : null;
  const escalated = wasActive && prev.level === "warning" && level === "urgent";
  if (lastSent != null && !escalated && now.getTime() - lastSent < RENOTIFY_MS[level]) return;

  const repeat = lastSent != null && !escalated;
  const text = `${ICON[level]} ${repeat ? "仍未解除：" : ""}${title}${detail ? `\n${detail}` : ""}`;
  if (await sendTelegram(text, { silent: level === "warning" && quietHours(now) })) {
    db().prepare("UPDATE alerts SET notified_at = ? WHERE key = ?").run(iso, key);
  }
}

/** Close the alert `key` if it is open. The recovery is announced only if the problem was. */
export async function resolveAlert(key: string, now = new Date()) {
  const prev = getAlert(key);
  if (!prev || prev.resolved_at != null) return;
  db().prepare("UPDATE alerts SET resolved_at = ?, updated_at = ? WHERE key = ?").run(now.toISOString(), now.toISOString(), key);
  if (prev.notified_at) await sendTelegram(`✅ 已恢復：${prev.title}`, { silent: quietHours(now) });
}

/** Resolve every open alert under `prefix` that is not in `keep` (e.g. per-account alerts of a deleted account). */
export async function resolveOthers(prefix: string, keep: Set<string>, now = new Date()) {
  for (const a of activeAlerts()) {
    if (a.key.startsWith(prefix) && !keep.has(a.key)) await resolveAlert(a.key, now);
  }
}
