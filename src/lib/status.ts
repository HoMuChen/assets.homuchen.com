import { activeAlerts, resolvedSince } from "./alerts";
import { db, type TwFuturesAccount } from "./db";
import { digestMode } from "./digest";
import { getRuns } from "./jobs";
import { feedStatuses, heartbeatsEnabled, riskThresholds } from "./monitor";
import { telegramConfigured } from "./telegram";
import { sinopacConfigured } from "./tw-futures";

/** Everything /status shows, read at one instant. */
export function getStatus(now = new Date()) {
  const alerts = activeAlerts();
  const runs = getRuns();
  const sinopac = db().prepare("SELECT * FROM tw_futures_accounts WHERE source = 'sinopac'").all() as TwFuturesAccount[];
  const latest = db().prepare("SELECT date, created_at FROM snapshots ORDER BY date DESC LIMIT 1").get() as
    | { date: string; created_at: string }
    | undefined;
  const monitor = runs.get("monitor") ?? null;
  return {
    now: now.getTime(),
    alerts,
    recent: resolvedSince(new Date(now.getTime() - 7 * 86_400_000)),
    openKeys: new Set(alerts.map((a) => a.key)),
    runs,
    feeds: feedStatuses(now),
    sinopac: {
      accounts: sinopac.length,
      configured: sinopacConfigured(),
      anyError: sinopac.some((r) => r.sync_error),
      lastSyncAt: sinopac.map((r) => r.synced_at).filter(Boolean).sort().at(-1) ?? null,
    },
    // created_at is SQLite datetime('now'): UTC without a zone.
    snapshot: latest ? { date: latest.date, at: `${latest.created_at.replace(" ", "T")}Z` } : null,
    /** The 5-minute health check ran recently. */
    monitorFresh: !!monitor?.last_ok_at && now.getTime() - Date.parse(monitor.last_ok_at) < 15 * 60_000,
    telegram: telegramConfigured(),
    heartbeats: heartbeatsEnabled(),
    risk: riskThresholds(),
    digest: digestMode(),
  };
}
