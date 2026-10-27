import { activeAlerts, raiseAlert, resolveAlert, resolveOthers } from "./alerts";
import { db, type JobRun, type TwFuturesAccount } from "./db";
import { fmtPct, fmtTime, fmtTwd } from "./format";
import { getRuns, isFailing } from "./jobs";
import { getPriceMap, heldInstruments } from "./prices";
import { isTwFuturesOpen, isTwMarketOpen } from "./time";
import { sinopacConfigured } from "./tw-futures";

// Every check opens or resolves its own alert keys (src/lib/alerts.ts); the scheduler runs them all
// every 5 minutes, and the margin checks again right after each SinoPac sync while TAIFEX is open.

const startedAt = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

const envPct = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** 風險指標 thresholds in %. TAIFEX liquidates intraday below 25%, and margin calls start around 75–80%. */
export function riskThresholds() {
  return { warning: envPct("ALERT_TW_RISK_WARN", 150), urgent: envPct("ALERT_TW_RISK_URGENT", 100) };
}
/** Once open, a risk alert clears only this many points above the warning threshold, so it doesn't flap. */
const RISK_HYSTERESIS = 10;

const sinopacRows = () =>
  db().prepare("SELECT * FROM tw_futures_accounts WHERE source = 'sinopac' ORDER BY id").all() as TwFuturesAccount[];

export async function checkTwFuturesRisk(now = new Date()) {
  const { warning, urgent } = riskThresholds();
  const open = new Set(activeAlerts().map((a) => a.key));
  const flagged = new Set<string>();
  for (const a of sinopacRows()) {
    const key = `twfut-risk:${a.id}`;
    const risk = a.risk_indicator ?? 0;
    // With no open positions there is no margin to watch, and SinoPac reports the indicator as 0.
    const hasPositions = (a.maintenance_margin ?? 0) > 0 || (a.initial_margin ?? 0) > 0;
    const facts = `權益數 ${fmtTwd(a.equity)}、風險指標 ${fmtPct(risk, false)}、可用保證金 ${fmtTwd(a.available_margin)}`;
    if ((a.margin_call ?? 0) > 0) {
      flagged.add(key);
      await raiseAlert(key, "urgent", `${a.name} 期貨追繳`, `追繳金額 ${fmtTwd(a.margin_call)}\n${facts}`, now);
    } else if (hasPositions && risk > 0 && risk < warning + (open.has(key) ? RISK_HYSTERESIS : 0)) {
      flagged.add(key);
      await raiseAlert(
        key,
        risk < urgent ? "urgent" : "warning",
        `${a.name} 風險指標偏低`,
        `${facts}\n門檻：${warning}% 警示、${urgent}% 緊急`,
        now,
      );
    }
  }
  await resolveOthers("twfut-risk:", flagged, now);
}

export async function checkSinopacSync(now = new Date()) {
  // Scheduled syncs run every few minutes in session and hourly outside it; allow a few misses either way.
  const grace = isTwFuturesOpen(now) ? 15 * MIN : 3 * HOUR;
  const failing = sinopacConfigured()
    ? sinopacRows().filter((r) => r.sync_error && (!r.synced_at || now.getTime() - Date.parse(r.synced_at) > grace))
    : [];
  if (failing.length === 0) return resolveAlert("sync:sinopac", now);
  const r = failing[0];
  await raiseAlert(
    "sync:sinopac",
    "warning",
    "永豐期貨同步失敗",
    `${r.sync_error}\n最後成功：${fmtTime(r.synced_at)}${isTwFuturesOpen(now) ? "（盤中，權益數與風險指標不是最新）" : ""}`,
    now,
  );
}

export type FeedStatus = {
  key: "tw" | "crypto" | "fx";
  label: string;
  source: string;
  maxAgeMs: number;
  items: number;
  /** Instruments whose quote is missing or older than maxAgeMs. */
  stale: string[];
  newestAt: string | null;
  run: JobRun | null;
};

/** Freshness of each quote feed, over what the holdings currently need. */
export function feedStatuses(now = new Date()): FeedStatus[] {
  const prices = getPriceMap();
  const runs = getRuns();
  const held = heldInstruments();
  const feed = (key: FeedStatus["key"], label: string, source: string, maxAgeMs: number, wanted: [string, string][]) => {
    const times = wanted.map(([k]) => prices.get(k)?.fetched_at ?? null);
    return {
      key,
      label,
      source,
      maxAgeMs,
      items: wanted.length,
      stale: wanted.filter((_, i) => !times[i] || now.getTime() - Date.parse(times[i]!) > maxAgeMs).map(([, name]) => name),
      newestAt: times.filter(Boolean).sort().at(-1) ?? null,
      run: runs.get(`feed:${key}`) ?? null,
    };
  };
  // Refresh cadence: stocks every minute in session and every 30 min otherwise, crypto every 5 min, FX hourly.
  return [
    feed("tw", "台股報價", "FinMind", isTwMarketOpen(now) ? 15 * MIN : 2 * HOUR, held.symbols.map((s) => [`tw:${s}`, s])),
    feed("crypto", "加密貨幣報價", "CoinGecko", 30 * MIN, held.coinIds.map((c) => [`crypto:${c}`, c])),
    feed("fx", "外幣匯率", "open.er-api.com", 3 * HOUR, held.currencies.map((c) => [`fx:${c}`, c])),
  ];
}

const fmtSpan = (ms: number) => (ms >= HOUR ? `${Math.round(ms / HOUR)} 小時` : `${Math.round(ms / MIN)} 分鐘`);

export async function checkQuotes(now = new Date()) {
  for (const f of feedStatuses(now)) {
    const key = `feed:${f.key}`;
    if (f.stale.length === 0) {
      await resolveAlert(key, now);
      continue;
    }
    const names = f.stale.length > 5 ? `${f.stale.slice(0, 5).join("、")} 等 ${f.stale.length} 項` : f.stale.join("、");
    const error = isFailing(f.run) ? `\n最近錯誤：${f.run!.last_error}` : "";
    await raiseAlert(key, "warning", `${f.label}中斷`, `${names} 超過 ${fmtSpan(f.maxAgeMs)}沒有更新${error}`, now);
  }
}

/** The 23:55 snapshot rewrites created_at daily; an hour of slack covers restarts around midnight. */
const SNAPSHOT_MAX_AGE_MS = 25 * HOUR;
/** SQLite datetime('now') (UTC, no zone) → epoch ms. */
const sqliteTime = (s: string) => Date.parse(`${s.replace(" ", "T")}Z`);

export async function checkSnapshot(now = new Date()) {
  const run = getRuns().get("snapshot");
  const latest = db().prepare("SELECT date, created_at FROM snapshots ORDER BY date DESC LIMIT 1").get() as
    | { date: string; created_at: string }
    | undefined;
  if (isFailing(run)) return raiseAlert("snapshot", "warning", "每日快照失敗", run!.last_error, now);
  if (latest && now.getTime() - sqliteTime(latest.created_at) > SNAPSHOT_MAX_AGE_MS) {
    return raiseAlert("snapshot", "warning", "超過一天沒有快照", `最後一筆是 ${latest.date}`, now);
  }
  await resolveAlert("snapshot", now);
}

/** Timers on the VM that report to /api/heartbeat (infra/backup/). */
export const HEARTBEATS = [
  { job: "backup", label: "資料庫備份", maxAgeMs: 26 * HOUR },
  { job: "restore-check", label: "備份還原演練", maxAgeMs: 8 * 24 * HOUR },
] as const;

export const heartbeatsEnabled = () => !!process.env.HEARTBEAT_TOKEN;

export async function checkHeartbeats(now = new Date()) {
  const runs = getRuns();
  for (const h of HEARTBEATS) {
    const key = `heartbeat:${h.job}`;
    const run = runs.get(h.job);
    // A timer that never reported gets one full interval from process start before it counts as missed.
    const lastOk = run?.last_ok_at ? Date.parse(run.last_ok_at) : startedAt;
    if (!heartbeatsEnabled()) await resolveAlert(key, now);
    else if (isFailing(run)) await raiseAlert(key, "warning", `${h.label}失敗`, run!.last_error, now);
    else if (now.getTime() - lastOk > h.maxAgeMs) {
      await raiseAlert(
        key,
        "warning",
        `${h.label}沒有按時執行`,
        run?.last_ok_at ? `最後成功：${fmtTime(run.last_ok_at)}` : "從未回報過",
        now,
      );
    } else await resolveAlert(key, now);
  }
}

const CHECKS: [string, (now: Date) => Promise<unknown>][] = [
  ["futures risk", checkTwFuturesRisk],
  ["sinopac sync", checkSinopacSync],
  ["quotes", checkQuotes],
  ["snapshot", checkSnapshot],
  ["heartbeats", checkHeartbeats],
];

/** Run every check; one failing check doesn't stop the rest, but the run as a whole reports it. */
export async function runChecks(now = new Date()) {
  const failures: string[] = [];
  for (const [name, check] of CHECKS) {
    try {
      await check(now);
    } catch (e) {
      failures.push(`${name}: ${(e as Error).message}`);
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
}
