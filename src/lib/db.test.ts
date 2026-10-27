import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db, migrate, SCHEMA_VERSION } from "./db";

const tables = (conn: Database.Database) =>
  (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
const columns = (conn: Database.Database, table: string) =>
  (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("schema migrations", () => {
  let conn: Database.Database | null = null;
  afterEach(() => conn?.close());

  it("brings a new database to the latest version", () => {
    expect(db().pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(tables(db())).toEqual(expect.arrayContaining(["snapshots", "prices", "sessions"]));
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
      INSERT INTO cash_accounts (name, balance) VALUES ('薪轉', 123456);
      INSERT INTO snapshots VALUES ('2026-10-14', 1, 1, 0, 1, 0, 0, 0, 0, '{}', '2026-10-14 15:55:00');
    `);

    migrate(conn);

    expect(conn.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(columns(conn, "snapshots")).toContain("tw_futures");
    expect(conn.prepare("SELECT tw_futures FROM snapshots").get()).toEqual({ tw_futures: 0 });
    expect(conn.prepare("SELECT name, balance FROM cash_accounts").get()).toEqual({ name: "薪轉", balance: 123456 });
    expect(tables(conn)).toEqual(expect.arrayContaining(["stock_holdings", "tw_futures_accounts"]));
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
