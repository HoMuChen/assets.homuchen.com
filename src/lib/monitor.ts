import { activeAlerts, raiseAlert, resolveAlert, resolveOthers } from "./alerts";
import { bybitConfigured } from "./bybit";
import { db, type FuturesAccount, type FuturesPosition, type JobRun, type TwFuturesAccount } from "./db";
import { fmtNum, fmtPct, fmtPrice, fmtTime, fmtTwd } from "./format";
import { getRuns, isFailing, recordRun } from "./jobs";
import { compareWithLedger } from "./legacy";
import { ledgerMode } from "./ledger";
import { getPriceMap, heldInstruments } from "./prices";
import { getSetting } from "./settings";
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

/**
 * Bybit liquidation watch. A position alerts when its mark price is within `warning`% of its liquidation price
 * (urgent within `urgent`%); the account alerts when its maintenance margin rate reaches `warning`% (urgent at
 * `urgent`%; Bybit liquidates at 100%). In cross margin the per-position liquidation price is Bybit's estimate.
 */
export function liquidationThresholds() {
  return {
    distance: { warning: envPct("ALERT_LIQ_WARN", 15), urgent: envPct("ALERT_LIQ_URGENT", 7) },
    marginRate: { warning: envPct("ALERT_MMR_WARN", 50), urgent: envPct("ALERT_MMR_URGENT", 75) },
  };
}
/** Readings older than this are left alone: the sync check reports a stalled sync instead. */
const BYBIT_FRESH_MS = 10 * MIN;

/** % of the mark price the market can move against the position before it is liquidated. */
export function liquidationDistance(p: Pick<FuturesPosition, "side" | "mark_price" | "liq_price">): number | null {
  if (!p.mark_price || !p.liq_price) return null;
  return ((p.side === "long" ? p.mark_price - p.liq_price : p.liq_price - p.mark_price) / p.mark_price) * 100;
}

export async function checkBybitRisk(now = new Date()) {
  const { distance, marginRate } = liquidationThresholds();
  const open = new Set(activeAlerts().map((a) => a.key));
  const flagged = new Set<string>();
  const accounts = db().prepare("SELECT * FROM futures_accounts WHERE source = 'bybit' ORDER BY id").all() as FuturesAccount[];
  for (const a of accounts) {
    const fresh = !!a.synced_at && now.getTime() - Date.parse(a.synced_at) < BYBIT_FRESH_MS;
    const positions = db().prepare("SELECT * FROM futures_positions WHERE account_id = ? ORDER BY id").all(a.id) as FuturesPosition[];
    // Keep whatever is open while the readings are stale, rather than announcing a recovery nobody saw.
    if (!fresh) {
      for (const k of open) if (k.startsWith(`liq:${a.id}:`) || k === `mmr:${a.id}`) flagged.add(k);
      continue;
    }
    const mmr = a.margin_rate != null ? `帳戶維持保證金率 ${fmtPct(a.margin_rate, false)}` : "";
    for (const p of positions) {
      const d = liquidationDistance(p);
      const key = `liq:${a.id}:${p.symbol}:${p.side}`;
      // Once open, clear only a few points past the threshold, so it doesn't flap.
      if (d == null || d >= distance.warning + (open.has(key) ? 3 : 0)) continue;
      flagged.add(key);
      await raiseAlert(
        key,
        d < distance.urgent ? "urgent" : "warning",
        `${a.name} ${p.symbol} ${p.side === "long" ? "多單" : "空單"}接近強平`,
        `標記價 ${fmtPrice(p.mark_price)}、強平價 ${fmtPrice(p.liq_price)}，距離 ${fmtNum(d, 1)}%\n數量 ${fmtNum(p.quantity, 8)}${mmr ? `\n${mmr}` : ""}\n門檻：${distance.warning}% 警示、${distance.urgent}% 緊急`,
        now,
      );
    }
    const key = `mmr:${a.id}`;
    if (a.margin_rate != null && a.margin_rate >= marginRate.warning - (open.has(key) ? 5 : 0)) {
      flagged.add(key);
      await raiseAlert(
        key,
        a.margin_rate >= marginRate.urgent ? "urgent" : "warning",
        `${a.name} 保證金率偏高`,
        `${mmr}（到 100% 會被強平）\n門檻：${marginRate.warning}% 警示、${marginRate.urgent}% 緊急`,
        now,
      );
    }
  }
  await resolveOthers("liq:", flagged, now);
  await resolveOthers("mmr:", flagged, now);
}

export async function checkBybitSync(now = new Date()) {
  const run = getRuns().get("sync:bybit");
  const linked = !!db().prepare("SELECT 1 FROM futures_accounts WHERE source = 'bybit' UNION SELECT 1 FROM accounts WHERE kind = 'crypto' AND source = 'bybit'").get();
  // Syncs run every minute; a few failures in a row are a blip.
  const lastOk = run?.last_ok_at ? Date.parse(run.last_ok_at) : startedAt;
  if (!bybitConfigured() || !linked || !isFailing(run) || now.getTime() - lastOk < 15 * MIN) return resolveAlert("sync:bybit", now);
  await raiseAlert("sync:bybit", "warning", "Bybit 同步失敗", `${run!.last_error}\n最後成功：${fmtTime(run!.last_ok_at)}（合約餘額、部位與強平價不是最新）`, now);
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

/** Days the ledger must agree with the old tables before it can become the source of truth. */
export const LEDGER_TRIAL_DAYS = 7;

/** Compare the ledger with the old tables it shadows; any difference is a bug in one of them. */
export async function checkLedger(now = new Date()) {
  const diffs = compareWithLedger();
  recordRun("ledger:compare", diffs.length ? `${diffs.length} 筆不一致` : null, now);
  if (!diffs.length) return resolveAlert("ledger:compare", now);
  const lines = diffs.slice(0, 3).map((d) => `${d.label}：舊 ${d.legacy}／帳本 ${d.ledger}`);
  if (diffs.length > 3) lines.push(`…共 ${diffs.length} 筆`);
  await raiseAlert("ledger:compare", "warning", "帳本與舊持股資料不一致", lines.join("\n"), now);
}

/** How the shadow run stands: agreeing since when, and whether the switch to the ledger is open. */
export function ledgerTrial(now = new Date()) {
  const run = getRuns().get("ledger:compare");
  const ledgerStart = getSetting("ledger_started_at");
  const agreeing = !!run && !isFailing(run);
  // Agreeing since the later of the ledger's start and the last mismatch.
  const since = agreeing ? ([ledgerStart, run.last_error_at].filter((x): x is string => !!x).sort().at(-1) ?? run.last_run_at) : null;
  const days = since ? (now.getTime() - Date.parse(since)) / (24 * HOUR) : 0;
  const fresh = !!run && now.getTime() - Date.parse(run.last_run_at) < 15 * MIN;
  return {
    mode: ledgerMode(),
    checked: !!run,
    agreeing,
    since,
    days,
    ready: agreeing && fresh && days >= LEDGER_TRIAL_DAYS,
  };
}

const CHECKS: [string, (now: Date) => Promise<unknown>][] = [
  ["futures risk", checkTwFuturesRisk],
  ["sinopac sync", checkSinopacSync],
  ["bybit risk", checkBybitRisk],
  ["bybit sync", checkBybitSync],
  ["quotes", checkQuotes],
  ["snapshot", checkSnapshot],
  ["heartbeats", checkHeartbeats],
  ["ledger", checkLedger],
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
