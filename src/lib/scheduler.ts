import cron from "node-cron";
import { refreshPrices } from "./prices";
import { hasSnapshot, takeSnapshot } from "./snapshot";
import { TZ, taipeiDate } from "./time";

const g = globalThis as unknown as { __assetsScheduler?: boolean };

const log = (label: string) => (e: unknown) => console.error(`[scheduler] ${label} failed:`, e);

export function startScheduler() {
  if (g.__assetsScheduler) return;
  g.__assetsScheduler = true;

  // Taiwan stocks: every minute through the trading session (09:00–13:35, Mon–Fri).
  cron.schedule("* 9-13 * * 1-5", () => refreshPrices().catch(log("stock refresh")), { timezone: TZ });
  // Crypto & FX: every 5 minutes, around the clock.
  cron.schedule("*/5 * * * *", () => refreshPrices().catch(log("refresh")), { timezone: TZ });
  // Daily snapshot near end of day, so it captures the day's close and late crypto moves.
  cron.schedule("55 23 * * *", () => takeSnapshot().catch(log("daily snapshot")), { timezone: TZ });

  // Make sure today has a snapshot even if the server was down at 23:55 yesterday.
  setTimeout(() => {
    if (!hasSnapshot(taipeiDate())) takeSnapshot().catch(log("startup snapshot"));
    else refreshPrices().catch(log("startup refresh"));
  }, 3_000);

  console.log("[scheduler] started (Asia/Taipei)");
}
