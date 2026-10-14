import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cash_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  institution TEXT,
  currency    TEXT NOT NULL DEFAULT 'TWD',
  balance     REAL NOT NULL DEFAULT 0,
  note        TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_holdings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT NOT NULL,
  name       TEXT,
  shares     REAL NOT NULL DEFAULT 0,
  avg_cost   REAL,
  broker     TEXT,
  note       TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crypto_holdings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  coin_id      TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  name         TEXT,
  amount       REAL NOT NULL DEFAULT 0,
  avg_cost_twd REAL,
  location     TEXT,
  note         TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  cash_invested    REAL NOT NULL DEFAULT 0,
  estimated_value  REAL,
  loan_amount      REAL NOT NULL DEFAULT 0,
  annual_rate      REAL NOT NULL DEFAULT 0,
  term_months      INTEGER NOT NULL DEFAULT 360,
  grace_months     INTEGER NOT NULL DEFAULT 0,
  loan_start_date  TEXT,
  balance_override REAL,
  note             TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- USDT-margined perpetual/futures. Equity = wallet_balance + Σ unrealized PnL.
CREATE TABLE IF NOT EXISTS futures_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  wallet_balance REAL NOT NULL DEFAULT 0,
  note           TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS futures_positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES futures_accounts(id) ON DELETE CASCADE,
  coin_id     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  name        TEXT,
  side        TEXT NOT NULL CHECK (side IN ('long', 'short')),
  quantity    REAL NOT NULL,
  entry_price REAL NOT NULL,
  leverage    REAL,
  note        TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Latest quote cache. key: 'tw:2330' | 'crypto:bitcoin' (TWD) | 'crypto_usd:bitcoin' (USD) | 'fx:USD' (TWD per 1 unit)
CREATE TABLE IF NOT EXISTS prices (
  key        TEXT PRIMARY KEY,
  price      REAL NOT NULL,
  change_pct REAL,
  source     TEXT NOT NULL,
  as_of      TEXT,
  fetched_at TEXT NOT NULL
);

-- One row per Asia/Taipei calendar day; re-taking a snapshot the same day overwrites it.
CREATE TABLE IF NOT EXISTS snapshots (
  date              TEXT PRIMARY KEY,
  net_worth         REAL NOT NULL,
  total_assets      REAL NOT NULL,
  total_liabilities REAL NOT NULL,
  cash              REAL NOT NULL,
  stocks            REAL NOT NULL,
  crypto            REAL NOT NULL,
  real_estate       REAL NOT NULL,
  mortgage          REAL NOT NULL,
  detail            TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const globalForDb = globalThis as unknown as { __assetsDb?: Database.Database };

export function db(): Database.Database {
  if (!globalForDb.__assetsDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const conn = new Database(path.join(DATA_DIR, "assets.db"));
    conn.pragma("journal_mode = WAL");
    conn.pragma("busy_timeout = 5000");
    conn.pragma("foreign_keys = ON");
    conn.exec(SCHEMA);
    globalForDb.__assetsDb = conn;
  }
  return globalForDb.__assetsDb;
}

export type CashAccount = {
  id: number;
  name: string;
  institution: string | null;
  currency: string;
  balance: number;
  note: string | null;
};

export type StockHolding = {
  id: number;
  symbol: string;
  name: string | null;
  shares: number;
  avg_cost: number | null;
  broker: string | null;
  note: string | null;
};

export type CryptoHolding = {
  id: number;
  coin_id: string;
  symbol: string;
  name: string | null;
  amount: number;
  avg_cost_twd: number | null;
  location: string | null;
  note: string | null;
};

export type Property = {
  id: number;
  name: string;
  cash_invested: number;
  estimated_value: number | null;
  loan_amount: number;
  annual_rate: number;
  term_months: number;
  grace_months: number;
  loan_start_date: string | null;
  balance_override: number | null;
  note: string | null;
};

export type FuturesAccount = {
  id: number;
  name: string;
  wallet_balance: number;
  note: string | null;
};

export type FuturesPosition = {
  id: number;
  account_id: number;
  coin_id: string;
  symbol: string;
  name: string | null;
  side: "long" | "short";
  quantity: number;
  entry_price: number;
  leverage: number | null;
  note: string | null;
};

export type PriceRow = {
  key: string;
  price: number;
  change_pct: number | null;
  source: string;
  as_of: string | null;
  fetched_at: string;
};

export type SnapshotRow = {
  date: string;
  net_worth: number;
  total_assets: number;
  total_liabilities: number;
  cash: number;
  stocks: number;
  crypto: number;
  real_estate: number;
  mortgage: number;
  detail: string;
  created_at: string;
};
