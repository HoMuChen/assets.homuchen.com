import cron from "node-cron";
import { bybitConfigured, syncBybit } from "./bybit";
import { sendDigest } from "./digest";
import { tracked } from "./jobs";
import { checkBybitRisk, checkSinopacSync, checkTwFuturesRisk, runChecks } from "./monitor";
import { refreshPrices } from "./prices";
import { pruneAuthTables } from "./session";
import { hasSnapshot, takeSnapshot } from "./snapshot";
import { TZ, isTwFuturesOpen, taipeiDate } from "./time";
import { sinopacBackingOff, syncSinopac } from "./tw-futures";

const g = globalThis as unknown as { __assetsScheduler?: boolean };

const log = (label: string) => (e: unknown) => console.error(`[scheduler] ${label} failed:`, e);

async function dailySnapshot() {
  const row = await tracked("snapshot", takeSnapshot);
  await sendDigest(row);
}

async function watchMargin() {
  if (!isTwFuturesOpen() || sinopacBackingOff()) return;
  await syncSinopac();
  await checkTwFuturesRisk();
  await checkSinopacSync();
}

async function watchBybit() {
  if (!bybitConfigured()) return;
  const full = new Date().getMinutes() % 10 === 0;
  const r = await syncBybit(full ? "full" : "balances");
  if (r.synced) await checkBybitRisk();
}

export function startScheduler() {
  if (g.__assetsScheduler) return;
  g.__assetsScheduler = true;

  // Taiwan stocks: every minute through the trading session (09:00–13:35, Mon–Fri).
  cron.schedule("* 9-13 * * 1-5", () => refreshPrices().catch(log("stock refresh")), { timezone: TZ });
  // Crypto & FX: every 5 minutes, around the clock; then every health check (src/lib/monitor.ts).
  cron.schedule(
    "*/5 * * * *",
    async () => {
      await refreshPrices().catch(log("refresh"));
      await tracked("monitor", runChecks).catch(log("monitor"));
    },
    { timezone: TZ },
  );
  // TAIFEX margin watch: while futures trade, sync SinoPac every 3 minutes and check the risk indicator
  // straight away, rather than waiting for the 5-minute quote cycle.
  cron.schedule("*/3 * * * *", () => watchMargin().catch(log("margin watch")), { timezone: TZ });
  // Bybit trades around the clock: balances, positions and liquidation prices every minute, checked straight
  // away; every 10 minutes also fills, transfers and the reconciliation (src/lib/bybit.ts).
  cron.schedule("* * * * *", () => watchBybit().catch(log("bybit watch")), { timezone: TZ });
  // Daily snapshot near end of day, so it captures the day's close and late crypto moves.
  cron.schedule("55 23 * * *", () => dailySnapshot().catch(log("daily snapshot")), { timezone: TZ });

  // Housekeeping: expired sessions, stale login failures, finished locks.
  cron.schedule("10 4 * * *", () => tracked("auth-prune", pruneAuthTables).catch(log("auth prune")), { timezone: TZ });

  // Make sure today has a snapshot even if the server was down at 23:55 yesterday.
  setTimeout(() => {
    if (!hasSnapshot(taipeiDate())) tracked("snapshot", takeSnapshot).catch(log("startup snapshot"));
    else refreshPrices().catch(log("startup refresh"));
  }, 3_000);

  console.log("[scheduler] started (Asia/Taipei)");
}
