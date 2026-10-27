import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

/** The schema as it stood when versioning began (v1). Later changes go in MIGRATIONS, never here. */
const BASELINE = `
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

-- Taiwan (TAIFEX) futures accounts, valued at 權益數 (equity, TWD).
-- source 'manual': equity typed in by hand. 'sinopac': synced from the Shioaji sidecar (src/lib/tw-futures.ts);
-- account_ref pins the SinoPac futures account id once the first sync has seen it.
CREATE TABLE IF NOT EXISTS tw_futures_accounts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  broker             TEXT,
  source             TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sinopac')),
  account_ref        TEXT,
  equity             REAL NOT NULL DEFAULT 0,
  open_pnl           REAL,
  available_margin   REAL,
  initial_margin     REAL,
  maintenance_margin REAL,
  risk_indicator     REAL,
  margin_call        REAL,
  synced_at          TEXT,
  sync_error         TEXT,
  note               TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Login sessions. Only a SHA-256 of the cookie token is stored.
-- pw_fingerprint ties a session to the APP_PASSWORD it was created under.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash     TEXT PRIMARY KEY,
  pw_fingerprint TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  ip             TEXT,
  user_agent     TEXT
);

-- Brute-force protection. Times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS login_failures (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_at ON login_failures (at);
CREATE TABLE IF NOT EXISTS login_locks (
  scope TEXT PRIMARY KEY, -- 'ip:<addr>' or 'global'
  until INTEGER NOT NULL
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
  tw_futures        REAL NOT NULL DEFAULT 0,
  mortgage          REAL NOT NULL,
  detail            TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function addColumn(conn: Database.Database, table: string, column: string, ddl: string) {
  const cols = conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * Append-only: entry i takes the database from schema version i to i + 1 (PRAGMA user_version).
 * Keep every step additive (new tables, defaulted columns) so a rolled-back image still runs on the newer schema.
 */
const MIGRATIONS: ((conn: Database.Database) => void)[] = [
  // v1: baseline. Databases from before versioning already hold some of it; IF NOT EXISTS and addColumn adopt them.
  (conn) => {
    conn.exec(BASELINE);
    addColumn(conn, "snapshots", "tw_futures", "REAL NOT NULL DEFAULT 0");
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(conn: Database.Database) {
  const from = conn.pragma("user_version", { simple: true }) as number;
  if (from > SCHEMA_VERSION) {
    console.warn(`[db] schema v${from} is newer than this build's v${SCHEMA_VERSION} (rolled back?); running anyway`);
    return;
  }
  for (let v = from; v < SCHEMA_VERSION; v++) {
    conn.transaction(() => {
      MIGRATIONS[v](conn);
      conn.pragma(`user_version = ${v + 1}`);
    })();
    console.log(`[db] migrated schema to v${v + 1}`);
  }
}

const globalForDb = globalThis as unknown as { __assetsDb?: Database.Database };

export function db(): Database.Database {
  if (!globalForDb.__assetsDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const conn = new Database(path.join(DATA_DIR, "assets.db"));
    conn.pragma("journal_mode = WAL");
    conn.pragma("busy_timeout = 5000");
    conn.pragma("foreign_keys = ON");
    migrate(conn);
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

export type TwFuturesAccount = {
  id: number;
  name: string;
  broker: string | null;
  source: "manual" | "sinopac";
  account_ref: string | null;
  equity: number;
  open_pnl: number | null;
  available_margin: number | null;
  initial_margin: number | null;
  maintenance_margin: number | null;
  risk_indicator: number | null;
  margin_call: number | null;
  synced_at: string | null;
  sync_error: string | null;
  note: string | null;
  updated_at: string;
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
  tw_futures: number;
  mortgage: number;
  detail: string;
  created_at: string;
};
