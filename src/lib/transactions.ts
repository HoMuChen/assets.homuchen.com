// Every write to the ledger goes through here, so the old tables (src/lib/legacy.ts) stay in step.

import { db, type Account, type AccountKind, type Transaction, type TxType } from "./db";
import { applyToLegacy, syncLegacy } from "./legacy";
import { getAccount, getTransaction, instruments, QTY_EPS, replay, seriesAt, seriesTx } from "./ledger";
import { taipeiDate } from "./time";

/** A rule the ledger enforces; its message is shown to the user as is. */
export class LedgerError extends Error {}

export type TxInput = {
  accountId: number;
  date: string;
  type: TxType;
  asset: string | null;
  quantity: number;
  price: number | null;
  amount: number;
  fee: number;
  tax: number;
  note: string | null;
  source?: string;
  externalId?: string | null;
};

const assetLabel = (asset: string | null) => (asset ? (instruments().get(asset)?.symbol ?? asset) : "餘額");

/** Refuse a change that would leave a series holding less than nothing at any point. */
function checkSeries(asset: string | null, txs: Transaction[]) {
  if (asset == null) return;
  const bad = replay(txs).negativeAt;
  if (bad) throw new LedgerError(`${assetLabel(asset)} 在 ${bad.date} 之後的數量會變成負數，請檢查日期與數量`);
}

function checkInput(input: TxInput, account: Account, now: Date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new LedgerError("日期格式 YYYY-MM-DD");
  if (input.date > taipeiDate(now)) throw new LedgerError("日期不能晚於今天");
  // Cash and futures wallets hold one balance (asset NULL); brokers and exchanges hold assets.
  const cashLike = account.kind === "cash" || account.kind === "futures";
  if (cashLike !== (input.asset == null)) throw new LedgerError("這個帳戶不能記這種交易");
}

const draft = (input: TxInput, id: number): Transaction => ({
  id,
  account_id: input.accountId,
  date: input.date,
  type: input.type,
  asset: input.asset,
  quantity: input.quantity,
  price: input.price,
  amount: input.amount,
  fee: input.fee,
  tax: input.tax,
  source: input.source ?? "manual",
  external_id: input.externalId ?? null,
  note: input.note,
  created_at: "",
  updated_at: "",
});

function mustAccount(id: number): Account {
  const a = getAccount(id);
  if (!a) throw new LedgerError("找不到這個帳戶");
  return a;
}

/**
 * Record one transaction. Returns its id, or null when a transaction with the same (source, external_id)
 * already exists, so a sync can be re-run safely.
 */
export function addTransaction(input: TxInput, now = new Date()): number | null {
  return db().transaction(() => {
    // Checked before the series: replaying a sell that is already in would see it twice.
    if (input.externalId != null && recorded(input.source ?? "manual", input.externalId)) return null;
    const account = mustAccount(input.accountId);
    checkInput(input, account, now);
    const series = seriesTx(account.id, input.asset);
    checkSeries(input.asset, [...series, draft(input, Number.MAX_SAFE_INTEGER)]);
    const at = now.toISOString();
    const r = db()
      .prepare(
        `INSERT INTO transactions (account_id, date, type, asset, quantity, price, amount, fee, tax, source, external_id, note, created_at, updated_at)
         VALUES (@accountId, @date, @type, @asset, @quantity, @price, @amount, @fee, @tax, @source, @externalId, @note, @at, @at)
         ON CONFLICT DO NOTHING`,
      )
      .run({ ...input, source: input.source ?? "manual", externalId: input.externalId ?? null, at });
    if (r.changes === 0) return null;
    const id = Number(r.lastInsertRowid);
    // Appending in date order is the old forms' incremental update; anything back-dated is re-derived.
    if (series.some((t) => t.date > input.date)) syncLegacy(account.id, input.asset);
    else applyToLegacy(getTransaction(id)!);
    return id;
  })();
}

/** A transaction with this id at this source is already in the ledger. */
export function recorded(source: string, externalId: string): boolean {
  return !!db().prepare("SELECT 1 FROM transactions WHERE source = ? AND external_id = ?").get(source, externalId);
}

function editable(id: number): Transaction {
  const tx = getTransaction(id);
  if (!tx) throw new LedgerError("找不到這筆交易");
  if (tx.source !== "manual") throw new LedgerError("同步進來的交易不能修改");
  return tx;
}

export function updateTransaction(id: number, input: TxInput, now = new Date()) {
  db().transaction(() => {
    const old = editable(id);
    const account = mustAccount(input.accountId);
    if (account.kind !== mustAccount(old.account_id).kind) throw new LedgerError("不能把交易移到不同類型的帳戶");
    checkInput(input, account, now);
    const sameSeries = old.account_id === input.accountId && old.asset === input.asset;
    const others = seriesTx(input.accountId, input.asset).filter((t) => t.id !== id);
    checkSeries(input.asset, [...others, draft(input, id)]);
    if (!sameSeries) checkSeries(old.asset, seriesTx(old.account_id, old.asset).filter((t) => t.id !== id));
    db()
      .prepare(
        `UPDATE transactions SET account_id=@accountId, date=@date, type=@type, asset=@asset, quantity=@quantity, price=@price,
         amount=@amount, fee=@fee, tax=@tax, note=@note, updated_at=@at WHERE id=@id`,
      )
      .run({ ...input, id, at: now.toISOString() });
    syncLegacy(input.accountId, input.asset);
    if (!sameSeries) syncLegacy(old.account_id, old.asset);
  })();
}

export function deleteTransaction(id: number) {
  db().transaction(() => {
    const tx = editable(id);
    checkSeries(tx.asset, seriesTx(tx.account_id, tx.asset).filter((t) => t.id !== id));
    db().prepare("DELETE FROM transactions WHERE id = ?").run(id);
    syncLegacy(tx.account_id, tx.asset);
  })();
}

/**
 * Move units between two of your own accounts of the same kind (a broker transfer, coins to an exchange),
 * keeping their cost: the receiving side takes the sender's average cost as of that date. The receiving
 * side carries `source` / `externalId` when it comes from a sync. Returns the receiving transaction's id.
 */
export function transferAsset(
  v: { fromId: number; toId: number; asset: string; quantity: number; date: string; note: string | null; source?: string; externalId?: string | null },
  now = new Date(),
): number | null {
  return db().transaction(() => {
    const from = mustAccount(v.fromId);
    const to = mustAccount(v.toId);
    if (from.id === to.id) throw new LedgerError("轉出和轉入不能是同一個帳戶");
    if (from.kind !== to.kind || (from.kind !== "stock" && from.kind !== "crypto")) throw new LedgerError("只能在同類型的券商或交易所帳戶之間轉移");
    if (!(v.quantity > 0)) throw new LedgerError("轉移數量必須大於 0");
    const held = seriesAt(from.id, v.asset, v.date);
    const price = held.cost == null || held.quantity <= QTY_EPS ? null : held.cost / held.quantity;
    const base = { date: v.date, type: "transfer" as const, asset: v.asset, amount: 0, fee: 0, tax: 0 };
    const id = addTransaction(
      { ...base, accountId: to.id, quantity: v.quantity, price, note: v.note ?? `從 ${from.name} 轉入`, source: v.source, externalId: v.externalId },
      now,
    );
    if (id == null) return null;
    addTransaction({ ...base, accountId: from.id, quantity: -v.quantity, price: null, note: `轉到 ${to.name}` }, now);
    return id;
  })();
}

// ---------- accounts ----------

/** The account of this kind with this name, created if there is none (the forms take a typed name). */
export function accountByName(kind: Exclude<AccountKind, "cash">, name: string, now = new Date()): Account {
  const found = db().prepare("SELECT * FROM accounts WHERE kind = ? AND name = ? ORDER BY id LIMIT 1").get(kind, name) as Account | undefined;
  if (found) return found;
  const at = now.toISOString();
  const r = db()
    .prepare("INSERT INTO accounts (kind, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(kind, name, at, at);
  return getAccount(Number(r.lastInsertRowid))!;
}

export function updateAccount(
  id: number,
  v: { name: string; institution: string | null; feeDiscount: number | null; note: string | null; source?: string },
  now = new Date(),
) {
  db().transaction(() => {
    const account = mustAccount(id);
    if (account.kind !== "cash") {
      const clash = db().prepare("SELECT 1 FROM accounts WHERE kind = ? AND name = ? AND id != ?").get(account.kind, v.name, id);
      if (clash) throw new LedgerError(`已經有叫「${v.name}」的帳戶`);
    }
    db()
      .prepare("UPDATE accounts SET name=?, institution=?, fee_discount=?, note=?, source=?, updated_at=? WHERE id=?")
      .run(v.name, v.institution, v.feeDiscount, v.note, v.source ?? account.source, now.toISOString(), id);
    // The old tables label rows by broker / location name.
    if (account.kind === "stock") db().prepare("UPDATE stock_holdings SET broker = ? WHERE account_id = ?").run(v.name, id);
    if (account.kind === "crypto") db().prepare("UPDATE crypto_holdings SET location = ? WHERE account_id = ?").run(v.name, id);
  })();
}

/** Delete an account with all its transactions. */
export function deleteAccount(id: number) {
  db().transaction(() => {
    db().prepare("DELETE FROM accounts WHERE id = ?").run(id);
    for (const t of ["cash_accounts", "stock_holdings", "crypto_holdings"]) db().prepare(`DELETE FROM ${t} WHERE account_id = ?`).run(id);
    // A synced futures wallet starts a new ledger account at its next sync.
    db().prepare("UPDATE futures_accounts SET account_id = NULL WHERE account_id = ?").run(id);
  })();
}

/**
 * Create or edit a cash account from its balance as the bank shows it. A new account opens with that
 * balance; a changed balance on an existing one is recorded as an adjustment dated today.
 */
export function saveCashAccount(
  v: { id: number | null; name: string; institution: string | null; currency: string; balance: number; note: string | null },
  now = new Date(),
) {
  db().transaction(() => {
    const at = now.toISOString();
    const date = taipeiDate(now);
    if (v.id == null) {
      const r = db()
        .prepare("INSERT INTO accounts (kind, name, institution, currency, note, created_at, updated_at) VALUES ('cash', ?, ?, ?, ?, ?, ?)")
        .run(v.name, v.institution, v.currency, v.note, at, at);
      const id = Number(r.lastInsertRowid);
      db()
        .prepare("INSERT INTO cash_accounts (name, institution, currency, balance, note, account_id) VALUES (?, ?, ?, 0, ?, ?)")
        .run(v.name, v.institution, v.currency, v.note, id);
      addTransaction({ accountId: id, date, type: "open", asset: null, quantity: 0, price: null, amount: v.balance, fee: 0, tax: 0, note: null }, now);
      return;
    }
    const account = mustAccount(v.id);
    if (account.kind !== "cash") throw new LedgerError("不是現金帳戶");
    db()
      .prepare("UPDATE accounts SET name=?, institution=?, currency=?, note=?, updated_at=? WHERE id=?")
      .run(v.name, v.institution, v.currency, v.note, at, v.id);
    db()
      .prepare("UPDATE cash_accounts SET name=?, institution=?, currency=?, note=?, updated_at=datetime('now') WHERE account_id=?")
      .run(v.name, v.institution, v.currency, v.note, v.id);
    const current = seriesTx(v.id, null).reduce((s, t) => s + t.amount, 0);
    const delta = v.balance - current;
    if (Math.abs(delta) > 1e-9) {
      addTransaction({ accountId: v.id, date, type: "adjust", asset: null, quantity: 0, price: null, amount: delta, fee: 0, tax: 0, note: null }, now);
    }
    // The old form set the balance outright; so does its mirror.
    db().prepare("UPDATE cash_accounts SET balance = ? WHERE account_id = ?").run(v.balance, v.id);
  })();
}
