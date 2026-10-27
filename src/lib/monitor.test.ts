import { beforeEach, describe, expect, it, vi } from "vitest";
import { at, cashAccount, holding, insert, resetDb, setPrice } from "@/test/helpers";
import { activeAlerts } from "./alerts";
import { db } from "./db";
import { recordRun } from "./jobs";
import {
  checkBybitRisk,
  checkBybitSync,
  checkHeartbeats,
  checkLedger,
  checkQuotes,
  checkSinopacSync,
  checkSnapshot,
  checkTwFuturesRisk,
  ledgerTrial,
  liquidationDistance,
  runChecks,
} from "./monitor";
import { setSetting } from "./settings";

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

describe("checkBybitRisk", () => {
  const NOW = at("2026-10-27 12:00");
  const MIN = 60_000;
  const account = (fields: Record<string, unknown> = {}) =>
    insert("futures_accounts", { name: "Bybit UTA", source: "bybit", wallet_balance: 1000, margin_rate: 10, synced_at: new Date(NOW.getTime() - MIN).toISOString(), ...fields });
  const position = (accountId: number, fields: Record<string, unknown> = {}) =>
    insert("futures_positions", { account_id: accountId, coin_id: "bitcoin", symbol: "BTC", side: "long", quantity: 0.1, entry_price: 60_000, mark_price: 65_000, liq_price: 50_000, ...fields });
  const setLiq = (id: number, liq: number) => db().prepare("UPDATE futures_positions SET liq_price = ? WHERE id = ?").run(liq, id);
  const setRate = (id: number, rate: number) => db().prepare("UPDATE futures_accounts SET margin_rate = ? WHERE id = ?").run(rate, id);

  it("measures the distance against the position's side", () => {
    expect(liquidationDistance({ side: "long", mark_price: 100, liq_price: 90 })).toBeCloseTo(10);
    expect(liquidationDistance({ side: "short", mark_price: 100, liq_price: 120 })).toBeCloseTo(20);
    expect(liquidationDistance({ side: "long", mark_price: 100, liq_price: null })).toBeNull();
  });

  it("warns within 15% of liquidation, escalates within 7%, and clears 3 points past the line", async () => {
    const a = account();
    const p = position(a);
    await checkBybitRisk(NOW);
    expect(activeAlerts()).toEqual([]);

    setLiq(p, 56_000); // 13.8%
    await checkBybitRisk(NOW);
    const key = `liq:${a}:BTC:long`;
    expect(open()[key]).toMatchObject({ level: "warning", title: "Bybit UTA BTC 多單接近強平" });
    expect(open()[key].detail).toContain("距離 13.8%");

    setLiq(p, 61_000); // 6.2%
    await checkBybitRisk(NOW);
    expect(open()[key].level).toBe("urgent");

    setLiq(p, 54_000); // 16.9%: past 15 but inside the band
    await checkBybitRisk(NOW);
    expect(open()[key].level).toBe("warning");

    setLiq(p, 50_000);
    await checkBybitRisk(NOW);
    expect(activeAlerts()).toEqual([]);
  });

  it("watches the account's maintenance margin rate", async () => {
    const a = account({ margin_rate: 55 });
    await checkBybitRisk(NOW);
    expect(open()[`mmr:${a}`]).toMatchObject({ level: "warning", title: "Bybit UTA 保證金率偏高" });
    setRate(a, 80);
    await checkBybitRisk(NOW);
    expect(open()[`mmr:${a}`].level).toBe("urgent");
    setRate(a, 47);
    await checkBybitRisk(NOW);
    expect(open()[`mmr:${a}`].level).toBe("warning");
    setRate(a, 40);
    await checkBybitRisk(NOW);
    expect(activeAlerts()).toEqual([]);
  });

  it("keeps what is open while the readings are stale, and clears a closed position's alert", async () => {
    const a = account();
    const p = position(a, { liq_price: 60_000 });
    await checkBybitRisk(NOW);
    expect(activeAlerts()).toHaveLength(1);

    setLiq(p, 40_000);
    db().prepare("UPDATE futures_accounts SET synced_at = ? WHERE id = ?").run(new Date(NOW.getTime() - 20 * MIN).toISOString(), a);
    await checkBybitRisk(NOW);
    expect(activeAlerts()).toHaveLength(1);

    db().prepare("UPDATE futures_accounts SET synced_at = ? WHERE id = ?").run(NOW.toISOString(), a);
    db().prepare("DELETE FROM futures_positions").run();
    await checkBybitRisk(NOW);
    expect(activeAlerts()).toEqual([]);
  });

  it("honours thresholds from the environment, and leaves manual accounts alone", async () => {
    vi.stubEnv("ALERT_LIQ_WARN", "30");
    const a = account();
    position(a); // 23%
    position(insert("futures_accounts", { name: "手動", wallet_balance: 1, margin_rate: 99 }), { liq_price: 64_000 });
    await checkBybitRisk(NOW);
    expect(Object.keys(open())).toEqual([`liq:${a}:BTC:long`]);
  });
});

describe("checkBybitSync", () => {
  const NOW = at("2026-10-27 12:00");
  const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

  it("alerts once syncs have failed for 15 minutes, and only when Bybit is set up and linked", async () => {
    insert("futures_accounts", { name: "Bybit UTA", source: "bybit" });
    recordRun("sync:bybit", null, ago(20));
    recordRun("sync:bybit", "Bybit API：timeout", ago(1));
    await checkBybitSync(NOW);
    expect(activeAlerts()).toEqual([]); // no key: local dev

    vi.stubEnv("BYBIT_API_KEY", "k");
    vi.stubEnv("BYBIT_API_SECRET", "s");
    await checkBybitSync(NOW);
    expect(open()["sync:bybit"].detail).toContain("timeout");

    recordRun("sync:bybit", null, NOW);
    await checkBybitSync(NOW);
    expect(activeAlerts()).toEqual([]);

    recordRun("sync:bybit", "Bybit API：timeout", NOW);
    await checkBybitSync(new Date(NOW.getTime() + 5 * 60_000));
    expect(activeAlerts()).toEqual([]); // a blip
  });
});

describe("checkQuotes", () => {
  const SAT = at("2026-10-31 12:00"); // TWSE closed: 2 h for stocks

  it("flags a feed whose held instruments have stale or missing quotes, then clears it", async () => {
    holding("tw:2330", 1, null);
    holding("tw:0050", 1, null);
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
    holding("crypto:bitcoin", 1, null);
    cashAccount("美元戶", 1, "USD");
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

describe("checkLedger / ledgerTrial", () => {
  it("alerts while the old tables and the ledger disagree, and counts agreeing days from the last mismatch", async () => {
    setSetting("ledger_started_at", at("2026-10-20 09:00").toISOString());
    holding("tw:2330", 1_000, 500);
    expect(ledgerTrial(at("2026-10-27 08:00"))).toMatchObject({ mode: "shadow", checked: false, ready: false });

    await checkLedger(at("2026-10-27 08:00"));
    expect(open()["ledger:compare"]).toBeUndefined();
    expect(ledgerTrial(at("2026-10-27 08:05"))).toMatchObject({ agreeing: true, ready: false, days: expect.closeTo(7 - 1 / 24 + 5 / 1440, 6) });
    expect(ledgerTrial(at("2026-10-27 09:05")).ready).toBe(false); // agreeing for 7 days, but no check in 15 minutes

    await checkLedger(at("2026-10-27 09:01"));
    expect(ledgerTrial(at("2026-10-27 09:05")).ready).toBe(true);

    db().prepare("UPDATE stock_holdings SET shares = 1").run();
    await checkLedger(at("2026-10-27 09:10"));
    expect(open()["ledger:compare"]).toMatchObject({ level: "warning", detail: "2330（國泰）：舊 1，成本 500／帳本 1,000，成本 500,000" });
    expect(ledgerTrial(at("2026-10-27 09:12"))).toMatchObject({ agreeing: false, since: null, ready: false });

    db().prepare("UPDATE stock_holdings SET shares = 1000").run();
    await checkLedger(at("2026-10-27 09:15"));
    expect(open()["ledger:compare"]).toBeUndefined();
    expect(ledgerTrial(at("2026-10-28 09:10")).days).toBeCloseTo(1, 6);
  });

  it("summarises a long list of differences", async () => {
    for (const s of ["2330", "0050", "2317", "2454"]) holding(`tw:${s}`, 1, 1);
    db().prepare("UPDATE stock_holdings SET shares = 2").run();
    await checkLedger(at("2026-10-27 09:00"));
    expect(open()["ledger:compare"].detail?.split("\n")).toHaveLength(4);
    expect(open()["ledger:compare"].detail).toContain("…共 4 筆");
  });
});

describe("runChecks", () => {
  it("runs every check and reports a failing one without skipping the rest", async () => {
    holding("tw:2330", 1, null); // no quote → feed alert
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
