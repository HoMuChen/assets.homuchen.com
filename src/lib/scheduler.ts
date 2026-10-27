import cron from "node-cron";
import { sendDigest } from "./digest";
import { tracked } from "./jobs";
import { checkSinopacSync, checkTwFuturesRisk, runChecks } from "./monitor";
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
