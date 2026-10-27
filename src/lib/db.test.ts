import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { holding, resetDb } from "@/test/helpers";
import { adoptLegacyRows, db, migrate, SCHEMA_VERSION } from "./db";
import { compareWithLedger } from "./legacy";

const tables = (conn: Database.Database) =>
  (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
const columns = (conn: Database.Database, table: string) =>
  (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("schema migrations", () => {
  let conn: Database.Database | null = null;
  afterEach(() => conn?.close());

  it("brings a new database to the latest version", () => {
    expect(db().pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(tables(db())).toEqual(expect.arrayContaining(["snapshots", "prices", "sessions", "job_runs", "alerts"]));
  });

  it("adopts a database from before versioning without losing data", () => {
    conn = new Database(":memory:");
    // The October 2026 layout: no user_version, snapshots without tw_futures.
    conn.exec(`
      CREATE TABLE cash_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, institution TEXT,
        currency TEXT NOT NULL DEFAULT 'TWD', balance REAL NOT NULL DEFAULT 0, note TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE snapshots (date TEXT PRIMARY KEY, net_worth REAL NOT NULL, total_assets REAL NOT NULL,
        total_liabilities REAL NOT NULL, cash REAL NOT NULL, stocks REAL NOT NULL, crypto REAL NOT NULL,
        real_estate REAL NOT NULL, mortgage REAL NOT NULL, detail TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE stock_holdings (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, name TEXT,
        shares REAL NOT NULL DEFAULT 0, avg_cost REAL, broker TEXT, note TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE crypto_holdings (id INTEGER PRIMARY KEY AUTOINCREMENT, coin_id TEXT NOT NULL, symbol TEXT NOT NULL,
        name TEXT, amount REAL NOT NULL DEFAULT 0, avg_cost_twd REAL, location TEXT, note TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO cash_accounts (name, balance) VALUES ('薪轉', 123456);
      INSERT INTO stock_holdings (symbol, name, shares, avg_cost, broker, note) VALUES
        ('2330', '台積電', 1000, 512.5, '國泰', '長抱'), ('0050', NULL, 30, NULL, NULL, NULL), ('2330', '台積電', 500, 600, '國泰', NULL);
      INSERT INTO crypto_holdings (coin_id, symbol, name, amount, avg_cost_twd, location) VALUES ('bitcoin', 'btc', 'Bitcoin', 0.25, 2000000, NULL);
      INSERT INTO snapshots VALUES ('2026-10-14', 1, 1, 0, 1, 0, 0, 0, 0, '{}', '2026-10-14 15:55:00');
    `);

    migrate(conn);

    expect(conn.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(columns(conn, "snapshots")).toContain("tw_futures");
    expect(conn.prepare("SELECT tw_futures FROM snapshots").get()).toEqual({ tw_futures: 0 });
    expect(conn.prepare("SELECT name, balance FROM cash_accounts").get()).toEqual({ name: "薪轉", balance: 123456 });
    expect(tables(conn)).toEqual(expect.arrayContaining(["stock_holdings", "tw_futures_accounts", "job_runs", "alerts", "transactions"]));

    // v3: one account per broker / location, and every holding an opening transaction at its cost.
    expect(conn.prepare("SELECT kind, name, institution, currency FROM accounts ORDER BY id").all()).toEqual([
      { kind: "cash", name: "薪轉", institution: null, currency: "TWD" },
      { kind: "stock", name: "國泰", institution: "國泰", currency: "TWD" },
      { kind: "stock", name: "台股", institution: null, currency: "TWD" },
      { kind: "crypto", name: "加密貨幣", institution: null, currency: "TWD" },
    ]);
    expect(conn.prepare("SELECT account_id, type, asset, quantity, price, amount, note FROM transactions ORDER BY id").all()).toEqual([
      { account_id: 1, type: "open", asset: null, quantity: 0, price: null, amount: 123456, note: null },
      { account_id: 2, type: "open", asset: "tw:2330", quantity: 1000, price: 512.5, amount: 0, note: "長抱" },
      { account_id: 3, type: "open", asset: "tw:0050", quantity: 30, price: null, amount: 0, note: null },
      { account_id: 2, type: "open", asset: "tw:2330", quantity: 500, price: 600, amount: 0, note: null },
      { account_id: 4, type: "open", asset: "crypto:bitcoin", quantity: 0.25, price: 2000000, amount: 0, note: null },
    ]);
    expect(conn.prepare("SELECT account_id FROM stock_holdings ORDER BY id").all()).toEqual([{ account_id: 2 }, { account_id: 3 }, { account_id: 2 }]);
    expect(conn.prepare("SELECT * FROM instruments ORDER BY asset").all()).toEqual([
      { asset: "crypto:bitcoin", symbol: "BTC", name: "Bitcoin" },
      { asset: "tw:0050", symbol: "0050", name: null },
      { asset: "tw:2330", symbol: "2330", name: "台積電" },
    ]);
  });

  it("adopts holdings a pre-ledger build wrote after a rollback", () => {
    resetDb();
    holding("tw:2330", 1_000, 500, { account: "國泰" });
    db().prepare("INSERT INTO stock_holdings (symbol, name, shares, avg_cost, broker) VALUES ('0050', '元大台灣50', 10, 190, '國泰')").run();
    db().prepare("INSERT INTO cash_accounts (name, currency, balance) VALUES ('美元戶', 'USD', 10)").run();
    expect(compareWithLedger()).toHaveLength(2);

    expect(adoptLegacyRows(db())).toBe(2);

    expect(compareWithLedger()).toEqual([]);
    expect(db().prepare("SELECT COUNT(*) AS n FROM accounts WHERE kind = 'stock'").get()).toEqual({ n: 1 });
    expect(adoptLegacyRows(db())).toBe(0);
  });

  it("is a no-op when already current", () => {
    conn = new Database(":memory:");
    migrate(conn);
    conn.prepare("INSERT INTO cash_accounts (name) VALUES ('x')").run();
    migrate(conn);
    expect(conn.prepare("SELECT COUNT(*) AS n FROM cash_accounts").get()).toEqual({ n: 1 });
  });

  it("keeps running on a newer schema, so a rolled-back image still starts", () => {
    conn = new Database(":memory:");
    migrate(conn);
    conn.pragma(`user_version = ${SCHEMA_VERSION + 3}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => migrate(conn!)).not.toThrow();
    expect(conn.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION + 3);
    expect(warn).toHaveBeenCalledOnce();
  });
});
