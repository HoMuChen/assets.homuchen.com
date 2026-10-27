// The reconciliation inbox: what a sync or an import found that the ledger doesn't have yet. Nothing here
// changes a holding until it is confirmed, except records marked `auto` (exchange fills), which apply
// themselves as soon as the ledger can take them.

import { db, type AccountKind, type InboxItem, type TxType } from "./db";
import { getAccount, instruments, seriesAt } from "./ledger";
import { addTransaction, LedgerError, recorded, transferAsset, type TxInput } from "./transactions";
import { assetId } from "./tx";

/** A diff has to outlast this before it is shown: a fill and the balance read just before it disagree briefly. */
export const DIFF_SETTLE_MS = 15 * 60_000;

export type NewRecord = {
  key: string;
  accountId: number;
  asset: string | null;
  source: string;
  date: string;
  type: TxType;
  quantity: number;
  price: number | null;
  amount: number;
  fee?: number;
  networkFee?: number;
  title: string;
  detail?: string | null;
  auto?: boolean;
  error?: string | null;
};

const cashLike = (kind: AccountKind | undefined) => kind === "cash" || kind === "futures";

/**
 * Add a source record to confirm. A key seen before (open or dismissed) is left as it is, apart from its error;
 * one already confirmed into the ledger isn't added again.
 */
export function addRecord(r: NewRecord, now = new Date()) {
  if (recorded(r.source, r.key)) return;
  const at = now.toISOString();
  db()
    .prepare(
      `INSERT INTO inbox (key, kind, account_id, asset, source, date, type, quantity, price, amount, fee, network_fee, title, detail, auto, error, first_seen_at, updated_at)
       VALUES (@key, 'record', @accountId, @asset, @source, @date, @type, @quantity, @price, @amount, @fee, @networkFee, @title, @detail, @auto, @error, @at, @at)
       ON CONFLICT(key) DO UPDATE SET error = excluded.error, updated_at = excluded.updated_at`,
    )
    .run({ fee: 0, networkFee: 0, detail: null, ...r, auto: r.auto ? 1 : 0, error: r.error ?? null, at });
}

const diffKey = (accountId: number, asset: string | null) => `diff:${accountId}:${asset ?? "cash"}`;

/**
 * Record what the source holds for one series as of `date` (a unit count, or the balance of a cash-like
 * account). The gap to the ledger is worked out when the inbox is read, so it closes as soon as the ledger
 * catches up. A dismissed diff opens again once the source reports a different number.
 */
export function reportHolding(
  v: { accountId: number; asset: string | null; source: string; date: string; observed: number; detail?: string | null },
  now = new Date(),
) {
  const key = diffKey(v.accountId, v.asset);
  const prev = db().prepare("SELECT * FROM inbox WHERE key = ?").get(key) as InboxItem | undefined;
  const gap = holdingGap(v.accountId, v.asset, v.date, v.observed);
  if (Math.abs(gap) <= tolerance(v.asset, v.observed)) {
    if (prev) db().prepare("DELETE FROM inbox WHERE id = ?").run(prev.id);
    return;
  }
  const at = now.toISOString();
  if (prev) {
    const reopened = prev.status === "dismissed" && !near(prev.observed ?? NaN, v.observed, v.asset);
    db()
      .prepare("UPDATE inbox SET date = ?, observed = ?, detail = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(v.date, v.observed, v.detail ?? null, reopened ? "open" : prev.status, at, prev.id);
    return;
  }
  db()
    .prepare(
      `INSERT INTO inbox (key, kind, account_id, asset, source, date, type, observed, title, detail, first_seen_at, updated_at)
       VALUES (?, 'diff', ?, ?, ?, ?, 'adjust', ?, '', ?, ?, ?)`,
    )
    .run(key, v.accountId, v.asset, v.source, v.date, v.observed, v.detail ?? null, at, at);
}

/** Forget the diffs one source reported for an account (e.g. it is no longer synced). */
export function clearSource(accountId: number, source: string) {
  db().prepare("DELETE FROM inbox WHERE account_id = ? AND source = ?").run(accountId, source);
}

const tolerance = (asset: string | null, observed: number) => (asset == null ? 0.005 : Math.max(1e-8, Math.abs(observed) * 1e-9));
const near = (a: number, b: number, asset: string | null) => Math.abs(a - b) <= tolerance(asset, b);

/** Units (or balance) in open records not yet in the ledger, up to `date`. */
function pending(accountId: number, asset: string | null, date: string): number {
  const r = db()
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN asset IS NULL THEN amount ELSE quantity END), 0) AS n FROM inbox
       WHERE kind = 'record' AND status = 'open' AND account_id = ? AND asset IS ? AND date <= ?`,
    )
    .get(accountId, asset, date) as { n: number };
  return r.n;
}

/** What the source reports minus what the ledger plus the records waiting to be confirmed already explain. */
function holdingGap(accountId: number, asset: string | null, date: string, observed: number): number {
  return observed - seriesAt(accountId, asset, date).quantity - pending(accountId, asset, date);
}

// ---------- reading ----------

export type InboxView = InboxItem & {
  accountName: string;
  accountKind: AccountKind;
  currency: string;
  symbol: string | null;
  /** diff: what the ledger has as of the item's date. */
  ledger: number | null;
};

/**
 * Open items, oldest first. Diffs are measured against the ledger as it is now: one the ledger has
 * caught up with is closed here, and a fresh one waits out DIFF_SETTLE_MS.
 */
export function openItems(now = new Date()): InboxView[] {
  const rows = db()
    .prepare(
      `SELECT i.*, a.name AS accountName, a.kind AS accountKind, a.currency AS currency FROM inbox i
       JOIN accounts a ON a.id = i.account_id WHERE i.status = 'open' ORDER BY i.date, i.id`,
    )
    .all() as (InboxItem & { accountName: string; accountKind: AccountKind; currency: string })[];
  const info = instruments();
  const out: InboxView[] = [];
  for (const r of rows) {
    const symbol = r.asset ? (info.get(r.asset)?.symbol ?? assetId(r.asset).toUpperCase()) : null;
    if (r.kind === "record") {
      out.push({ ...r, symbol, ledger: null });
      continue;
    }
    const ledger = seriesAt(r.account_id, r.asset, r.date).quantity;
    const gap = r.observed! - ledger - pending(r.account_id, r.asset, r.date);
    if (Math.abs(gap) <= tolerance(r.asset, r.observed!)) {
      db().prepare("DELETE FROM inbox WHERE id = ?").run(r.id);
      continue;
    }
    if (r.source !== "import" && now.getTime() - Date.parse(r.first_seen_at) < DIFF_SETTLE_MS) continue;
    const unit = r.asset ? (symbol ?? "") : r.currency;
    const source = r.source === "bybit" ? "Bybit" : "對帳單";
    out.push({
      ...r,
      symbol,
      ledger,
      quantity: r.asset ? gap : 0,
      amount: r.asset ? 0 : gap,
      title: `${r.asset ? symbol : "餘額"}：${source} ${fmt(r.observed!)}${r.asset ? "" : ` ${unit}`}，帳本 ${fmt(ledger)}`,
    });
  }
  return out;
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 8 });

export function openCount(now = new Date()): number {
  return openItems(now).length;
}

// ---------- applying ----------

/** Apply records the ledger couldn't take before (a sell ahead of the holding it needs); returns how many. */
export function retryAuto(now = new Date()): number {
  const items = db().prepare("SELECT * FROM inbox WHERE auto = 1 AND status = 'open' ORDER BY date, id").all() as InboxItem[];
  let applied = 0;
  for (const it of items) {
    try {
      addTransaction(recordInput(it), now);
      db().prepare("DELETE FROM inbox WHERE id = ?").run(it.id);
      applied++;
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      db().prepare("UPDATE inbox SET error = ?, updated_at = ? WHERE id = ?").run(e.message, now.toISOString(), it.id);
    }
  }
  return applied;
}

const recordInput = (it: InboxItem, note: string | null = it.title): TxInput => ({
  accountId: it.account_id,
  date: it.date,
  type: it.type,
  asset: it.asset,
  quantity: it.quantity,
  price: it.price,
  amount: it.amount,
  fee: it.fee,
  tax: 0,
  note,
  source: it.source,
  externalId: it.key,
});

export type Accept = {
  type: TxType;
  date: string;
  /** Units (positive in, negative out); ignored for a cash-like account. */
  quantity: number;
  /** Per unit, in TWD; NULL = unknown cost. */
  price: number | null;
  /** Balance change of a cash-like account. */
  amount: number;
  note: string | null;
  /** transfer: the other account of your own. */
  counterpartId?: number | null;
};

const ACCEPT_TYPES: Record<"cashLike" | "units", TxType[]> = {
  cashLike: ["deposit", "withdraw", "adjust", "transfer", "pnl", "fee", "funding"],
  units: ["adjust", "deposit", "withdraw", "transfer", "buy", "sell", "dividend", "fee"],
};

export function acceptTypes(kind: AccountKind): TxType[] {
  return ACCEPT_TYPES[cashLike(kind) ? "cashLike" : "units"];
}

/** Confirm one item as the given transaction (pre-filled from the item, edited by the user). */
export function acceptItem(id: number, v: Accept, now = new Date()) {
  db().transaction(() => {
    const it = db().prepare("SELECT * FROM inbox WHERE id = ? AND status = 'open'").get(id) as InboxItem | undefined;
    if (!it) throw new LedgerError("這筆已經處理過了");
    const account = getAccount(it.account_id)!;
    if (!acceptTypes(account.kind).includes(v.type)) throw new LedgerError("這個帳戶不能記這種交易");
    // A record keeps its id at the source, so it can't be written twice; a confirmed diff is your own entry.
    const ref = it.kind === "record" ? { source: it.source, externalId: it.key } : { source: "manual", externalId: null };
    if (cashLike(account.kind)) {
      if (!v.amount) throw new LedgerError("金額不能是 0");
      addTransaction({ ...ref, accountId: account.id, date: v.date, type: v.type, asset: null, quantity: 0, price: null, amount: v.amount, fee: 0, tax: 0, note: v.note }, now);
    } else if (v.type === "transfer") {
      if (!v.counterpartId) throw new LedgerError("請選擇對方帳戶");
      if (!v.quantity) throw new LedgerError("數量不能是 0");
      // Coins sent out arrive less the network fee, which stays here as a fee.
      const arrives = v.quantity < 0 ? -v.quantity - it.network_fee : v.quantity;
      transferAsset(
        { fromId: v.quantity < 0 ? account.id : v.counterpartId, toId: v.quantity < 0 ? v.counterpartId : account.id, asset: it.asset!, quantity: arrives, date: v.date, note: v.note, ...ref },
        now,
      );
      if (v.quantity < 0 && it.network_fee > 0) {
        addTransaction({ accountId: account.id, date: v.date, type: "fee", asset: it.asset, quantity: -it.network_fee, price: null, amount: 0, fee: 0, tax: 0, note: "提領手續費" }, now);
      }
    } else {
      if (!v.quantity && v.type !== "dividend") throw new LedgerError("數量不能是 0");
      const value = v.price == null ? 0 : Math.abs(v.quantity) * v.price;
      const amount = v.type === "buy" ? -value : v.type === "sell" ? value : 0;
      addTransaction({ ...ref, accountId: account.id, date: v.date, type: v.type, asset: it.asset, quantity: v.quantity, price: v.price, amount, fee: 0, tax: 0, note: v.note }, now);
    }
    db().prepare("DELETE FROM inbox WHERE id = ?").run(id);
  })();
}

/** Set an item aside. A dismissed record never comes back; a dismissed diff does if the source's number changes. */
export function dismissItem(id: number, now = new Date()) {
  db().prepare("UPDATE inbox SET status = 'dismissed', updated_at = ? WHERE id = ?").run(now.toISOString(), id);
}
