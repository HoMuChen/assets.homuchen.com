import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { taipeiDate } from "./time";

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
  // v2: monitoring (src/lib/jobs.ts, src/lib/alerts.ts). Times are ISO strings.
  (conn) =>
    conn.exec(`
      -- Last outcome of each background job, quote feed, and heartbeat from the VM's timers.
      CREATE TABLE job_runs (
        name          TEXT PRIMARY KEY,
        failing       INTEGER NOT NULL DEFAULT 0, -- 1 when the most recent run failed
        last_run_at   TEXT NOT NULL,
        last_ok_at    TEXT,
        last_error_at TEXT,
        last_error    TEXT
      );

      -- One row per alert condition; resolved_at IS NULL while it is active.
      CREATE TABLE alerts (
        key         TEXT PRIMARY KEY,
        level       TEXT NOT NULL CHECK (level IN ('urgent', 'warning')),
        title       TEXT NOT NULL,
        detail      TEXT,
        opened_at   TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        notified_at TEXT,
        resolved_at TEXT
      );
    `),
  // v3: the transaction ledger (src/lib/ledger.ts), seeded with today's holdings as opening balances.
  (conn) => {
    conn.exec(`
      -- Where money or holdings sit: a bank account (cash), a broker (TW stocks), an exchange or wallet (crypto).
      -- kind, source and transactions.type are open-ended (checked in the app): a CHECK can't be widened additively.
      CREATE TABLE accounts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL,                 -- 'cash' | 'stock' | 'crypto'
        name         TEXT NOT NULL,
        institution  TEXT,
        currency     TEXT NOT NULL DEFAULT 'TWD',   -- cash accounts: the balance's currency; others: TWD cost basis
        fee_discount REAL,                          -- broker commission discount, e.g. 0.6 = 6 折; NULL = list price
        source       TEXT NOT NULL DEFAULT 'manual',
        external_ref TEXT,                          -- the account's id at a synced source
        note         TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      -- Every change to a holding or balance. A holding is the replay of its (account_id, asset) series by (date, id).
      CREATE TABLE transactions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        date        TEXT NOT NULL,                  -- trade date, YYYY-MM-DD in Asia/Taipei
        type        TEXT NOT NULL,                  -- open | buy | sell | dividend | deposit | withdraw | fee | tax | adjust | funding
        asset       TEXT,                           -- 'tw:2330' | 'crypto:bitcoin'; NULL = the account's own cash
        quantity    REAL NOT NULL DEFAULT 0,        -- signed change in units of asset
        price       REAL,                           -- per unit in account currency; NULL = unknown cost
        amount      REAL NOT NULL DEFAULT 0,        -- signed cash leg net of fee and tax: + received, - paid
        fee         REAL NOT NULL DEFAULT 0,
        tax         REAL NOT NULL DEFAULT 0,
        source      TEXT NOT NULL DEFAULT 'manual', -- manual | import | sinopac | bybit
        external_id TEXT,                           -- id at the source, so a re-run sync can't write a duplicate
        note        TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX transactions_source_ref ON transactions (source, external_id);
      CREATE INDEX transactions_series ON transactions (account_id, asset, date);

      -- Display names for ledger assets.
      CREATE TABLE instruments (
        asset  TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name   TEXT
      );

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // Until the ledger is switched on, the old tables stay the source of truth and are kept in step
    // (src/lib/legacy.ts); account_id links each old row to its ledger account.
    for (const t of ["cash_accounts", "stock_holdings", "crypto_holdings"]) addColumn(conn, t, "account_id", "INTEGER");
    adoptLegacyRows(conn);
  },
  // v4: Bybit sync (src/lib/bybit.ts) and the reconciliation inbox (src/lib/inbox.ts).
  (conn) => {
    // source 'bybit': wallet, positions and margin come from the exchange, and account_id is the ledger account
    // ('futures' kind, in USDT) that records the wallet's transfers, realized PnL, fees and funding.
    addColumn(conn, "futures_accounts", "source", "TEXT NOT NULL DEFAULT 'manual'");
    addColumn(conn, "futures_accounts", "account_id", "INTEGER");
    addColumn(conn, "futures_accounts", "fund_balance", "REAL"); // USDT in Bybit's Funding account, included in wallet_balance
    addColumn(conn, "futures_accounts", "margin_rate", "REAL"); // maintenance margin ÷ margin balance, %; liquidation at 100
    addColumn(conn, "futures_accounts", "synced_at", "TEXT");
    addColumn(conn, "futures_accounts", "sync_error", "TEXT");
    // As the exchange reports them; NULL on manual positions, whose mark and PnL are estimated from CoinGecko.
    addColumn(conn, "futures_positions", "mark_price", "REAL");
    addColumn(conn, "futures_positions", "liq_price", "REAL");
    addColumn(conn, "futures_positions", "upnl", "REAL");
    conn.exec(`
      -- What a sync or an import found that the ledger doesn't have yet, waiting to be confirmed.
      -- kind 'record': one record at the source (a deposit, a fill that didn't fit the ledger yet);
      -- kind 'diff': a holding the source reports differently from the ledger.
      -- An accepted item becomes a transaction and is deleted; a dismissed one stays, so it isn't raised again.
      CREATE TABLE inbox (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        key           TEXT NOT NULL UNIQUE,     -- 'diff:<account>:<asset>' | the record's external_id
        kind          TEXT NOT NULL,            -- record | diff
        account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        asset         TEXT,                     -- NULL = the account's own cash / USDT wallet
        source        TEXT NOT NULL,            -- bybit | import
        date          TEXT NOT NULL,            -- of the suggested transaction; for a diff, when the source reported it
        type          TEXT NOT NULL,            -- suggested transaction type
        quantity      REAL NOT NULL DEFAULT 0,
        price         REAL,
        amount        REAL NOT NULL DEFAULT 0,
        fee           REAL NOT NULL DEFAULT 0,
        network_fee   REAL NOT NULL DEFAULT 0,  -- a coin withdrawal's network fee, in units, included in quantity
        observed      REAL,                     -- diff: what the source holds (units, or the balance when asset is NULL)
        title         TEXT NOT NULL,
        detail        TEXT,
        auto          INTEGER NOT NULL DEFAULT 0, -- record applied by itself once it fits the ledger
        error         TEXT,                     -- why it couldn't be applied yet
        status        TEXT NOT NULL DEFAULT 'open', -- open | dismissed
        first_seen_at TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `);
  },
];

/**
 * Old-table rows without a ledger account become opening transactions dated today, so the ledger reproduces
 * every number exactly. Seeds the ledger in v3, and on each start adopts rows a pre-ledger build wrote after
 * a rollback. Returns how many rows it adopted.
 */
export function adoptLegacyRows(conn: Database.Database): number {
  const now = new Date().toISOString();
  const today = taipeiDate();
  const account = conn.prepare(
    `INSERT INTO accounts (kind, name, institution, currency, note, created_at, updated_at)
     VALUES (@kind, @name, @institution, @currency, @note, @now, @now)`,
  );
  const open = conn.prepare(
    `INSERT INTO transactions (account_id, date, type, asset, quantity, price, amount, note, created_at, updated_at)
     VALUES (@account_id, @date, 'open', @asset, @quantity, @price, @amount, @note, @now, @now)`,
  );
  const instrument = conn.prepare(
    "INSERT INTO instruments (asset, symbol, name) VALUES (?, ?, ?) ON CONFLICT(asset) DO UPDATE SET name = COALESCE(excluded.name, name)",
  );
  const addAccount = (a: { kind: string; name: string; institution?: string | null; currency?: string; note?: string | null }) =>
    Number(account.run({ institution: null, currency: "TWD", note: null, ...a, now }).lastInsertRowid);
  let adopted = 0;

  for (const c of conn.prepare("SELECT * FROM cash_accounts WHERE account_id IS NULL ORDER BY id").all() as CashAccount[]) {
    const id = addAccount({ kind: "cash", name: c.name, institution: c.institution, currency: c.currency, note: c.note });
    conn.prepare("UPDATE cash_accounts SET account_id = ? WHERE id = ?").run(id, c.id);
    open.run({ account_id: id, date: today, asset: null, quantity: 0, price: null, amount: c.balance, note: null, now });
    adopted++;
  }

  // One account per broker / storage location as typed in the old forms.
  const seed = <T extends { id: number }>(
    table: string,
    kind: string,
    rows: T[],
    group: (r: T) => string | null,
    fallback: string,
    row: (r: T) => { asset: string; symbol: string; name: string | null; quantity: number; price: number | null; note: string | null },
  ) => {
    for (const r of rows) {
      const label = group(r);
      const name = label ?? fallback;
      const existing = conn.prepare("SELECT id FROM accounts WHERE kind = ? AND name = ? ORDER BY id LIMIT 1").get(kind, name) as
        | { id: number }
        | undefined;
      const id = existing?.id ?? addAccount({ kind, name, institution: label });
      conn.prepare(`UPDATE ${table} SET account_id = ? WHERE id = ?`).run(id, r.id);
      const { symbol, name: assetName, ...tx } = row(r);
      instrument.run(tx.asset, symbol, assetName);
      open.run({ ...tx, account_id: id, date: today, amount: 0, now });
      adopted++;
    }
  };
  seed(
    "stock_holdings",
    "stock",
    conn.prepare("SELECT * FROM stock_holdings WHERE account_id IS NULL ORDER BY id").all() as StockHolding[],
    (h) => h.broker,
    "台股",
    (h) => ({ asset: `tw:${h.symbol}`, symbol: h.symbol, name: h.name, quantity: h.shares, price: h.avg_cost, note: h.note }),
  );
  seed(
    "crypto_holdings",
    "crypto",
    conn.prepare("SELECT * FROM crypto_holdings WHERE account_id IS NULL ORDER BY id").all() as CryptoHolding[],
    (h) => h.location,
    "加密貨幣",
    (h) => ({
      asset: `crypto:${h.coin_id}`,
      symbol: h.symbol.toUpperCase(),
      name: h.name,
      quantity: h.amount,
      price: h.avg_cost_twd,
      note: h.note,
    }),
  );
  conn.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('ledger_started_at', ?, ?)").run(now, now);
  return adopted;
}

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
    if ((conn.pragma("user_version", { simple: true }) as number) >= 3) {
      const adopted = conn.transaction(adoptLegacyRows)(conn);
      if (adopted) console.warn(`[db] adopted ${adopted} holding row(s) written without the ledger (rolled back?)`);
    }
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
  /** Ledger account this row mirrors; NULL only for rows written by a pre-ledger build. */
  account_id: number | null;
};

export type StockHolding = {
  id: number;
  symbol: string;
  name: string | null;
  shares: number;
  avg_cost: number | null;
  broker: string | null;
  note: string | null;
  /** Ledger account this row mirrors; NULL only for rows written by a pre-ledger build. */
  account_id: number | null;
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
  /** Ledger account this row mirrors; NULL only for rows written by a pre-ledger build. */
  account_id: number | null;
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
  source: "manual" | "bybit";
  /** Ledger account ('futures' kind) recording the synced wallet's flows; NULL for manual accounts. */
  account_id: number | null;
  fund_balance: number | null;
  margin_rate: number | null;
  synced_at: string | null;
  sync_error: string | null;
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
  mark_price: number | null;
  liq_price: number | null;
  upnl: number | null;
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

export type JobRun = {
  name: string;
  failing: 0 | 1;
  last_run_at: string;
  last_ok_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
};

export type AlertLevel = "urgent" | "warning";

export type AlertRow = {
  key: string;
  level: AlertLevel;
  title: string;
  detail: string | null;
  opened_at: string;
  updated_at: string;
  notified_at: string | null;
  resolved_at: string | null;
};

/** 'futures': a synced futures wallet (USDT), recorded like a cash account; its value comes from futures_accounts. */
export type AccountKind = "cash" | "stock" | "crypto" | "futures";

export type Account = {
  id: number;
  kind: AccountKind;
  name: string;
  institution: string | null;
  currency: string;
  fee_discount: number | null;
  source: string;
  external_ref: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

/** transfer: between accounts of your own (not money in or out); pnl: a futures position's realized PnL. */
export type TxType =
  | "open"
  | "buy"
  | "sell"
  | "dividend"
  | "deposit"
  | "withdraw"
  | "transfer"
  | "fee"
  | "tax"
  | "adjust"
  | "funding"
  | "pnl";

export type Transaction = {
  id: number;
  account_id: number;
  date: string;
  type: TxType;
  asset: string | null;
  quantity: number;
  price: number | null;
  amount: number;
  fee: number;
  tax: number;
  source: string;
  external_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type Instrument = { asset: string; symbol: string; name: string | null };

export type InboxItem = {
  id: number;
  key: string;
  kind: "record" | "diff";
  account_id: number;
  asset: string | null;
  source: string;
  date: string;
  type: TxType;
  quantity: number;
  price: number | null;
  amount: number;
  fee: number;
  network_fee: number;
  observed: number | null;
  title: string;
  detail: string | null;
  auto: 0 | 1;
  error: string | null;
  status: "open" | "dismissed";
  first_seen_at: string;
  updated_at: string;
};
