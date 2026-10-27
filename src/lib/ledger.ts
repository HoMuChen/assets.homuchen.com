import { db, type Account, type AccountKind, type Instrument, type Transaction, type TxType } from "./db";
import { getSetting } from "./settings";
import { assetId } from "./tx";

/** Closer to zero than this counts as a closed position (float dust from fractional coins). */
export const QTY_EPS = 1e-9;

/** A stock or coin position, from either the ledger or the old per-holding tables. */
export type Holding = {
  accountId: number | null;
  account: string;
  /** 'tw:2330' | 'crypto:bitcoin' */
  asset: string;
  symbol: string;
  name: string | null;
  quantity: number;
  /** Cost basis of what's held, in TWD; null when any lot's cost is unknown. */
  cost: number | null;
};

export type CashBalance = {
  accountId: number | null;
  name: string;
  institution: string | null;
  currency: string;
  balance: number;
  note: string | null;
};

/**
 * 'shadow': the old tables are still what every page shows, and the ledger runs alongside for comparison.
 * 'primary': holdings and balances come from the ledger. The old tables are kept in step either way.
 */
export function ledgerMode(): "shadow" | "primary" {
  return getSetting("ledger_mode") === "primary" ? "primary" : "shadow";
}

// ---------- replay ----------

export type SeriesState = {
  quantity: number;
  cost: number | null;
  /** Realized PnL of each sell, net of fees and tax; sells of lots with unknown cost are left out. */
  realized: { date: string; amount: number }[];
  dividends: { date: string; amount: number }[];
  /** First transaction after which more was sold or moved out than was held. */
  negativeAt: Transaction | null;
};

const byDate = (a: Pick<Transaction, "date" | "id">, b: Pick<Transaction, "date" | "id">) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id;

/** Units these bring in carry their own cost (price per unit; NULL = unknown). Other additions cost nothing. */
export const COSTED_IN: readonly TxType[] = ["open", "buy", "deposit", "transfer"];

/**
 * Replays one (account, asset) series in date order, the way TW brokers report it: the cost basis is
 * the moving average including buy fees, a sell takes its share of that cost, and the realized PnL is
 * the net proceeds minus that cost. Stock dividends and adjustments add units at no cost; units added
 * to an empty position that way have an unknown cost. Deposits and transfers in come at their price,
 * e.g. the cost they had in the account they came from.
 */
export function replay(txs: Transaction[]): SeriesState {
  let quantity = 0;
  let cost: number | null = 0;
  const realized: SeriesState["realized"] = [];
  const dividends: SeriesState["dividends"] = [];
  let negativeAt: Transaction | null = null;

  for (const t of [...txs].sort(byDate)) {
    const before = quantity;
    quantity += t.quantity;
    if (t.quantity > 0) {
      if (COSTED_IN.includes(t.type)) {
        cost = cost == null || t.price == null ? null : cost + t.price * t.quantity + t.fee + t.tax;
      } else if (before <= QTY_EPS) {
        cost = null;
      }
    } else if (t.quantity < 0 && before > QTY_EPS) {
      const removed = cost == null ? null : cost * Math.min(1, -t.quantity / before);
      if (cost != null) cost -= removed!;
      if (t.type === "sell" && removed != null) realized.push({ date: t.date, amount: t.amount - removed });
    }
    if (t.type === "dividend") dividends.push({ date: t.date, amount: t.amount });
    if (quantity < -QTY_EPS) negativeAt ??= t;
    if (Math.abs(quantity) <= QTY_EPS) {
      quantity = 0;
      cost = 0;
    }
  }
  return { quantity, cost, realized, dividends, negativeAt };
}

// ---------- reads ----------

export function getAccounts(kind?: AccountKind): Account[] {
  return kind
    ? (db().prepare("SELECT * FROM accounts WHERE kind = ? ORDER BY id").all(kind) as Account[])
    : (db().prepare("SELECT * FROM accounts ORDER BY kind, id").all() as Account[]);
}

/** Number of transactions per account. */
export function txCounts(): Map<number, number> {
  const rows = db().prepare("SELECT account_id, COUNT(*) AS n FROM transactions GROUP BY account_id").all() as { account_id: number; n: number }[];
  return new Map(rows.map((r) => [r.account_id, r.n]));
}

export function getAccount(id: number): Account | undefined {
  return db().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Account | undefined;
}

export function getTransaction(id: number): Transaction | undefined {
  return db().prepare("SELECT * FROM transactions WHERE id = ?").get(id) as Transaction | undefined;
}

export function seriesTx(accountId: number, asset: string | null): Transaction[] {
  return db()
    .prepare("SELECT * FROM transactions WHERE account_id = ? AND asset IS ? ORDER BY date, id")
    .all(accountId, asset) as Transaction[];
}

export function instruments(): Map<string, Instrument> {
  const rows = db().prepare("SELECT * FROM instruments").all() as Instrument[];
  return new Map(rows.map((r) => [r.asset, r]));
}

export function saveInstrument(asset: string, symbol: string, name: string | null) {
  db()
    .prepare(
      `INSERT INTO instruments (asset, symbol, name) VALUES (?, ?, ?)
       ON CONFLICT(asset) DO UPDATE SET symbol = excluded.symbol, name = COALESCE(excluded.name, name)`,
    )
    .run(asset, symbol, name);
}

/** Every series of one account kind, replayed. */
function replayKind(kind: "stock" | "crypto") {
  const rows = db()
    .prepare(
      `SELECT t.* FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE a.kind = ? AND t.asset IS NOT NULL ORDER BY t.date, t.id`,
    )
    .all(kind) as Transaction[];
  const series = new Map<string, Transaction[]>();
  for (const t of rows) {
    const k = `${t.account_id}|${t.asset}`;
    series.set(k, [...(series.get(k) ?? []), t]);
  }
  return [...series.values()].map((txs) => ({ accountId: txs[0].account_id, asset: txs[0].asset!, state: replay(txs) }));
}

/** Open positions of one kind as the ledger has them. */
export function ledgerHoldings(kind: "stock" | "crypto"): Holding[] {
  const names = new Map(getAccounts(kind).map((a) => [a.id, a.name]));
  const info = instruments();
  return replayKind(kind)
    .filter((s) => s.state.quantity !== 0)
    .map((s) => ({
      accountId: s.accountId,
      account: names.get(s.accountId) ?? "",
      asset: s.asset,
      symbol: info.get(s.asset)?.symbol ?? assetId(s.asset).toUpperCase(),
      name: info.get(s.asset)?.name ?? null,
      quantity: s.state.quantity,
      cost: s.state.cost,
    }));
}

/** Cash accounts with their balance: the sum of every transaction's cash leg. */
export function ledgerCash(): CashBalance[] {
  return db()
    .prepare(
      `SELECT a.id AS accountId, a.name, a.institution, a.currency, a.note,
         COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.account_id = a.id AND t.asset IS NULL), 0) AS balance
       FROM accounts a WHERE a.kind = 'cash' ORDER BY balance DESC, a.id`,
    )
    .all() as CashBalance[];
}

/** Realized PnL and dividends of one kind within a calendar year (YYYY). */
export function ledgerIncome(kind: "stock" | "crypto", year: string) {
  let realized = 0;
  let dividends = 0;
  for (const { state } of replayKind(kind)) {
    for (const r of state.realized) if (r.date.startsWith(year)) realized += r.amount;
    for (const d of state.dividends) if (d.date.startsWith(year)) dividends += d.amount;
  }
  return { realized, dividends };
}

/** One series as of the end of `date`: units held (and their cost), or for a cash series the balance. */
export function seriesAt(accountId: number, asset: string | null, date: string) {
  const txs = seriesTx(accountId, asset).filter((t) => t.date <= date);
  if (asset == null) return { quantity: txs.reduce((s, t) => s + t.amount, 0), cost: null };
  const { quantity, cost } = replay(txs);
  return { quantity, cost };
}

/** Realized PnL, trading fees and funding of the synced futures wallets within a calendar year, in USDT. */
export function ledgerFuturesIncome(year: string): number {
  const r = db()
    .prepare(
      `SELECT COALESCE(SUM(t.amount), 0) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE a.kind = 'futures' AND t.type IN ('pnl', 'fee', 'funding') AND t.date LIKE ?`,
    )
    .get(`${year}-%`) as { n: number };
  return r.n;
}

export type TxRow = Transaction & {
  account_name: string;
  account_kind: AccountKind;
  account_currency: string;
  symbol: string | null;
  name: string | null;
};

export type TxFilter = { kind?: AccountKind; accountId?: number; asset?: string; type?: TxType; limit?: number };

/** Newest first. */
export function listTransactions(filter: TxFilter = {}): TxRow[] {
  const conds = (
    [
      ["a.kind = ?", filter.kind],
      ["t.account_id = ?", filter.accountId],
      ["t.asset = ?", filter.asset],
      ["t.type = ?", filter.type],
    ] as const
  ).filter(([, v]) => v != null);
  const where = conds.map(([c]) => c);
  const args = conds.map(([, v]) => v!);
  return db()
    .prepare(
      `SELECT t.*, a.name AS account_name, a.kind AS account_kind, a.currency AS account_currency, i.symbol, i.name
       FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN instruments i ON i.asset = t.asset
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY t.date DESC, t.id DESC LIMIT ?`,
    )
    .all(...args, filter.limit ?? 500) as TxRow[];
}
