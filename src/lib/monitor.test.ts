import { beforeEach, describe, expect, it, vi } from "vitest";
import { at, insert, resetDb, setPrice } from "@/test/helpers";
import { activeAlerts } from "./alerts";
import { db } from "./db";
import { recordRun } from "./jobs";
import { checkHeartbeats, checkQuotes, checkSinopacSync, checkSnapshot, checkTwFuturesRisk, runChecks } from "./monitor";

beforeEach(resetDb);

const HOUR = 3_600_000;
const open = () => Object.fromEntries(activeAlerts().map((a) => [a.key, a]));

describe("checkTwFuturesRisk", () => {
  const account = (fields: Record<string, unknown>) =>
    insert("tw_futures_accounts", {
      name: "永豐期貨",
      source: "sinopac",
      equity: 500_000,
      initial_margin: 300_000,
      maintenance_margin: 230_000,
      available_margin: 100_000,
      risk_indicator: 300,
      margin_call: 0,
      ...fields,
    });
  const setRisk = (id: number, risk: number) =>
    db().prepare("UPDATE tw_futures_accounts SET risk_indicator = ? WHERE id = ?").run(risk, id);

  it("stays quiet while the risk indicator is healthy", async () => {
    account({});
    await checkTwFuturesRisk();
    expect(activeAlerts()).toEqual([]);
  });

  it("warns below 150%, escalates below 100%, and clears only 10 points above the warning line", async () => {
    const id = account({ risk_indicator: 140 });
    await checkTwFuturesRisk();
    expect(open()[`twfut-risk:${id}`]).toMatchObject({ level: "warning", title: "永豐期貨 風險指標偏低" });

    setRisk(id, 95);
    await checkTwFuturesRisk();
    expect(open()[`twfut-risk:${id}`].level).toBe("urgent");

    setRisk(id, 155); // back above 150 but inside the hysteresis band
    await checkTwFuturesRisk();
    expect(open()[`twfut-risk:${id}`].level).toBe("warning");

    setRisk(id, 165);
    await checkTwFuturesRisk();
    expect(activeAlerts()).toEqual([]);
  });

  it("raises an urgent alert on a margin call regardless of the indicator", async () => {
    const id = account({ risk_indicator: 300, margin_call: 12_000 });
    await checkTwFuturesRisk();
    expect(open()[`twfut-risk:${id}`]).toMatchObject({ level: "urgent", title: "永豐期貨 期貨追繳" });
    expect(open()[`twfut-risk:${id}`].detail).toContain("NT$12,000");
  });

  it("ignores the indicator when there are no open positions", async () => {
    account({ risk_indicator: 0, initial_margin: 0, maintenance_margin: 0 });
    await checkTwFuturesRisk();
    expect(activeAlerts()).toEqual([]);
  });

  it("honours thresholds from the environment", async () => {
    vi.stubEnv("ALERT_TW_RISK_WARN", "400");
    account({ risk_indicator: 300 });
    await checkTwFuturesRisk();
    expect(activeAlerts()).toHaveLength(1);
  });

  it("clears the alert of an account that was deleted", async () => {
    const id = account({ risk_indicator: 120 });
    await checkTwFuturesRisk();
    db().prepare("DELETE FROM tw_futures_accounts WHERE id = ?").run(id);
    await checkTwFuturesRisk();
    expect(activeAlerts()).toEqual([]);
  });
});

describe("checkSinopacSync", () => {
  const SUNDAY = at("2026-11-01 12:00"); // futures closed: 3 h grace

  it("alerts only once a sync failure outlasts the grace period", async () => {
    vi.stubEnv("SINOPAC_URL", "http://sinopac:8000");
    const id = insert("tw_futures_accounts", {
      name: "永豐期貨",
      source: "sinopac",
      sync_error: "永豐 API：ConnectionRefused",
      synced_at: new Date(SUNDAY.getTime() - 2 * HOUR).toISOString(),
    });
    await checkSinopacSync(SUNDAY);
    expect(activeAlerts()).toEqual([]);

    db().prepare("UPDATE tw_futures_accounts SET synced_at = ? WHERE id = ?").run(new Date(SUNDAY.getTime() - 4 * HOUR).toISOString(), id);
    await checkSinopacSync(SUNDAY);
    expect(open()["sync:sinopac"].detail).toContain("ConnectionRefused");

    db().prepare("UPDATE tw_futures_accounts SET sync_error = NULL, synced_at = ? WHERE id = ?").run(SUNDAY.toISOString(), id);
    await checkSinopacSync(SUNDAY);
    expect(activeAlerts()).toEqual([]);
  });

  it("does nothing when the sidecar isn't configured (local dev)", async () => {
    insert("tw_futures_accounts", { name: "永豐期貨", source: "sinopac", sync_error: "x" });
    await checkSinopacSync(SUNDAY);
    expect(activeAlerts()).toEqual([]);
  });
});

describe("checkQuotes", () => {
  const SAT = at("2026-10-31 12:00"); // TWSE closed: 2 h for stocks

  it("flags a feed whose held instruments have stale or missing quotes, then clears it", async () => {
    insert("stock_holdings", { symbol: "2330", shares: 1 });
    insert("stock_holdings", { symbol: "0050", shares: 1 });
    setPrice("tw:2330", 1_000, { fetchedAt: new Date(SAT.getTime() - 3 * HOUR) });
    recordRun("feed:tw", "台股 2330: 502 Bad Gateway", new Date(SAT.getTime() - HOUR));

    await checkQuotes(SAT);
    const a = open()["feed:tw"];
    expect(a.title).toBe("台股報價中斷");
    expect(a.detail).toContain("2330、0050 超過 2 小時沒有更新");
    expect(a.detail).toContain("502 Bad Gateway");

    setPrice("tw:2330", 1_000, { fetchedAt: SAT });
    setPrice("tw:0050", 150, { fetchedAt: SAT });
    await checkQuotes(SAT);
    expect(activeAlerts()).toEqual([]);
  });

  it("checks crypto and FX against their own cadence", async () => {
    insert("crypto_holdings", { coin_id: "bitcoin", symbol: "btc", amount: 1 });
    insert("cash_accounts", { name: "美元戶", currency: "USD", balance: 1 });
    setPrice("crypto:bitcoin", 1, { fetchedAt: new Date(SAT.getTime() - 40 * 60_000) });
    setPrice("fx:USD", 32, { fetchedAt: new Date(SAT.getTime() - 2 * HOUR) });
    await checkQuotes(SAT);
    expect(Object.keys(open())).toEqual(["feed:crypto"]);
  });
});

describe("checkSnapshot", () => {
  const NOW = at("2026-10-27 12:00");
  const snapshot = (date: string, createdAt: string) =>
    insert("snapshots", {
      date,
      net_worth: 0,
      total_assets: 0,
      total_liabilities: 0,
      cash: 0,
      stocks: 0,
      crypto: 0,
      real_estate: 0,
      mortgage: 0,
      detail: "{}",
      created_at: createdAt,
    });

  it("is fine with last night's snapshot", async () => {
    snapshot("2026-10-26", "2026-10-26 15:55:00"); // 23:55 Taipei
    await checkSnapshot(NOW);
    expect(activeAlerts()).toEqual([]);
  });

  it("alerts when the newest snapshot is over 25 hours old", async () => {
    snapshot("2026-10-25", "2026-10-25 15:55:00");
    await checkSnapshot(NOW);
    expect(open().snapshot).toMatchObject({ title: "超過一天沒有快照", detail: "最後一筆是 2026-10-25" });
  });

  it("alerts when the last snapshot run failed", async () => {
    snapshot("2026-10-26", "2026-10-26 15:55:00");
    recordRun("snapshot", "SQLITE_BUSY");
    await checkSnapshot(NOW);
    expect(open().snapshot).toMatchObject({ title: "每日快照失敗", detail: "SQLITE_BUSY" });
  });
});

describe("checkHeartbeats", () => {
  const NOW = new Date(Date.now() + 30 * HOUR); // past every grace period since process start

  it("is off without HEARTBEAT_TOKEN", async () => {
    await checkHeartbeats(NOW);
    expect(activeAlerts()).toEqual([]);
  });

  it("alerts on a reported failure, on a missed run, and on a timer that never reported", async () => {
    vi.stubEnv("HEARTBEAT_TOKEN", "t");
    recordRun("backup", "upload failed (exit 22)", new Date(NOW.getTime() - HOUR));
    await checkHeartbeats(NOW);
    expect(open()["heartbeat:backup"]).toMatchObject({ title: "資料庫備份失敗", detail: "upload failed (exit 22)" });
    expect(open()["heartbeat:restore-check"]).toBeUndefined(); // weekly: still inside its 8 days

    recordRun("backup", null, new Date(NOW.getTime() - 27 * HOUR));
    await checkHeartbeats(NOW);
    expect(open()["heartbeat:backup"].title).toBe("資料庫備份沒有按時執行");

    recordRun("backup", null, new Date(NOW.getTime() - HOUR));
    await checkHeartbeats(NOW);
    expect(open()["heartbeat:backup"]).toBeUndefined();

    await checkHeartbeats(new Date(Date.now() + 9 * 24 * HOUR));
    expect(open()["heartbeat:restore-check"]).toMatchObject({ detail: "從未回報過" });
  });
});

describe("runChecks", () => {
  it("runs every check and reports a failing one without skipping the rest", async () => {
    insert("stock_holdings", { symbol: "2330", shares: 1 }); // no quote → feed alert
    db().exec("DROP TABLE snapshots"); // checkSnapshot will throw
    try {
      await expect(runChecks(at("2026-10-31 12:00"))).rejects.toThrow(/snapshot/);
      expect(open()["feed:tw"]).toBeDefined();
    } finally {
      db().exec(`CREATE TABLE snapshots (date TEXT PRIMARY KEY, net_worth REAL NOT NULL, total_assets REAL NOT NULL,
        total_liabilities REAL NOT NULL, cash REAL NOT NULL, stocks REAL NOT NULL, crypto REAL NOT NULL,
        real_estate REAL NOT NULL, tw_futures REAL NOT NULL DEFAULT 0, mortgage REAL NOT NULL, detail TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    }
  });
});
