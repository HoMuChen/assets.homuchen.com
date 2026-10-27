import { beforeEach, describe, expect, it, vi } from "vitest";
import { insert, resetDb } from "@/test/helpers";
import { raiseAlert, resolveAlert } from "./alerts";
import { recordRun } from "./jobs";
import { getStatus } from "./status";

beforeEach(resetDb);

describe("getStatus", () => {
  it("summarises alerts, jobs and configuration for /status", async () => {
    const now = new Date("2026-10-26T04:00:00Z");
    await raiseAlert("feed:tw", "warning", "台股報價中斷", null, now);
    await raiseAlert("snapshot", "warning", "超過一天沒有快照", null, new Date(now.getTime() - 2 * 86_400_000));
    await resolveAlert("snapshot", new Date(now.getTime() - 86_400_000));
    recordRun("monitor", null, new Date(now.getTime() - 5 * 60_000));
    insert("tw_futures_accounts", { name: "永豐期貨", source: "sinopac", synced_at: "2026-10-26T03:58:00.000Z" });
    vi.stubEnv("TELEGRAM_DIGEST", "full");

    const s = getStatus(now);

    expect(s.alerts.map((a) => a.key)).toEqual(["feed:tw"]);
    expect(s.recent.map((a) => a.key)).toEqual(["snapshot"]);
    expect(s.openKeys.has("feed:tw")).toBe(true);
    expect(s.monitorFresh).toBe(true);
    expect(s.sinopac).toEqual({ accounts: 1, configured: false, anyError: false, lastSyncAt: "2026-10-26T03:58:00.000Z" });
    expect(s.snapshot).toBeNull();
    expect(s).toMatchObject({ telegram: false, heartbeats: false, digest: "full", risk: { warning: 150, urgent: 100 } });
    expect(s.ledger).toMatchObject({ mode: "shadow", checked: false, diffs: [] });
  });

  it("reports the health check as stale when it hasn't run for 15 minutes", () => {
    const now = new Date("2026-10-26T04:00:00Z");
    recordRun("monitor", null, new Date(now.getTime() - 16 * 60_000));
    expect(getStatus(now).monitorFresh).toBe(false);
  });
});
