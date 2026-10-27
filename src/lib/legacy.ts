// The pre-ledger tables (cash_accounts, stock_holdings, crypto_holdings), kept in step with the ledger.
// They are what the pages show until the ledger is switched on, what a rolled-back build reads, and an
// independent second computation: appended transactions update them incrementally, the way the old forms
// did, and compareWithLedger() checks that against a full replay of the ledger.

import { db, type Account, type CashAccount, type CryptoHolding, type StockHolding, type Transaction } from "./db";
import {
  COSTED_IN,
  getAccount,
  getAccounts,
  instruments,
  ledgerCash,
  ledgerHoldings,
  QTY_EPS,
  replay,
  seriesTx,
  type CashBalance,
  type Holding,
} from "./ledger";
import { assetId } from "./tx";

const TABLE = {
  stock: { table: "stock_holdings", key: "symbol", qty: "shares", avg: "avg_cost", label: "broker" },
  crypto: { table: "crypto_holdings", key: "coin_id", qty: "amount", avg: "avg_cost_twd", label: "location" },
} as const;

const kindOf = (asset: string) => (asset.startsWith("tw:") ? "stock" : "crypto");
// stock_holdings keeps the symbol as typed; crypto_holdings keeps the CoinGecko id.
const keyOf = (asset: string) => (kindOf(asset) === "stock" ? assetId(asset).toUpperCase() : assetId(asset));

export function legacyHoldings(kind: "stock" | "crypto"): Holding[] {
  const accounts = new Map(getAccounts(kind).map((a) => [a.id, a.name]));
  const rows =
    kind === "stock"
      ? (db().prepare("SELECT * FROM stock_holdings ORDER BY id").all() as StockHolding[]).map((h) => ({
          accountId: h.account_id,
          label: h.broker,
          asset: `tw:${h.symbol}`,
          symbol: h.symbol,
          name: h.name,
          quantity: h.shares,
          avg: h.avg_cost,
        }))
      : (db().prepare("SELECT * FROM crypto_holdings ORDER BY id").all() as CryptoHolding[]).map((h) => ({
          accountId: h.account_id,
          label: h.location,
          asset: `crypto:${h.coin_id}`,
          symbol: h.symbol.toUpperCase(),
          name: h.name,
          quantity: h.amount,
          avg: h.avg_cost_twd,
        }));
  // The old forms allowed two rows for the same stock at the same broker; the ledger sees one position.
  const merged = new Map<string, Holding>();
  for (const r of rows) {
    const k = `${r.accountId ?? `?${r.label ?? ""}`}|${r.asset}`;
    const cost = r.avg == null ? null : r.avg * r.quantity;
    const prev = merged.get(k);
    merged.set(
      k,
      prev
        ? { ...prev, name: prev.name ?? r.name, quantity: prev.quantity + r.quantity, cost: prev.cost == null || cost == null ? null : prev.cost + cost }
        : {
            accountId: r.accountId,
            account: (r.accountId != null ? accounts.get(r.accountId) : null) ?? r.label ?? "",
            asset: r.asset,
            symbol: r.symbol,
            name: r.name,
            quantity: r.quantity,
            cost,
          },
    );
  }
  return [...merged.values()];
}

export function legacyCash(): CashBalance[] {
  return (db().prepare("SELECT * FROM cash_accounts ORDER BY balance DESC, id").all() as CashAccount[]).map((c) => ({
    accountId: c.account_id,
    name: c.name,
    institution: c.institution,
    currency: c.currency,
    balance: c.balance,
    note: c.note,
  }));
}

// ---------- writes ----------

/** Set one position's old-table row(s): one row per (account, asset), none once it's closed. */
function writePosition(account: Account, asset: string, quantity: number, avg: number | null) {
  const t = TABLE[kindOf(asset)];
  const conn = db();
  const rows = conn.prepare(`SELECT id FROM ${t.table} WHERE account_id = ? AND ${t.key} = ? ORDER BY id`).all(account.id, keyOf(asset)) as {
    id: number;
  }[];
  if (Math.abs(quantity) <= QTY_EPS) {
    conn.prepare(`DELETE FROM ${t.table} WHERE account_id = ? AND ${t.key} = ?`).run(account.id, keyOf(asset));
    return;
  }
  if (rows.length) {
    conn
      .prepare(`UPDATE ${t.table} SET ${t.qty} = ?, ${t.avg} = ?, ${t.label} = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(quantity, avg, account.name, rows[0].id);
    for (const r of rows.slice(1)) conn.prepare(`DELETE FROM ${t.table} WHERE id = ?`).run(r.id);
    return;
  }
  const info = instruments().get(asset);
  if (t.table === "stock_holdings") {
    conn
      .prepare("INSERT INTO stock_holdings (symbol, name, shares, avg_cost, broker, account_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(keyOf(asset), info?.name ?? null, quantity, avg, account.name, account.id);
  } else {
    conn
      .prepare("INSERT INTO crypto_holdings (coin_id, symbol, name, amount, avg_cost_twd, location, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(keyOf(asset), info?.symbol ?? keyOf(asset).toUpperCase(), info?.name ?? null, quantity, avg, account.name, account.id);
  }
}

function currentPosition(account: Account, asset: string): { quantity: number; avg: number | null } {
  const h = legacyHoldings(kindOf(asset)).find((x) => x.accountId === account.id && x.asset === asset);
  if (!h || Math.abs(h.quantity) <= QTY_EPS) return { quantity: 0, avg: null };
  return { quantity: h.quantity, avg: h.cost == null ? null : h.cost / h.quantity };
}

/** Apply one newly appended transaction to the old tables, as the old forms would have. */
export function applyToLegacy(tx: Transaction) {
  const account = getAccount(tx.account_id)!;
  if (tx.asset == null) {
    db().prepare("UPDATE cash_accounts SET balance = balance + ?, updated_at = datetime('now') WHERE account_id = ?").run(tx.amount, account.id);
    return;
  }
  const { quantity: held, avg } = currentPosition(account, tx.asset);
  const quantity = held + tx.quantity;
  let next = avg;
  if (tx.quantity > 0 && COSTED_IN.includes(tx.type)) {
    next = tx.price == null || (held > 0 && avg == null) ? null : (avg ?? 0) * held + tx.price * tx.quantity + tx.fee + tx.tax;
    if (next != null) next /= quantity;
  } else if (tx.quantity > 0) {
    // Units at no cost dilute the average; on an empty position their cost is unknown.
    next = held > 0 && avg != null ? (avg * held) / quantity : null;
  }
  writePosition(account, tx.asset, quantity, next);
}

/** Reset one series' old-table row from a full replay; for edits and back-dated entries. */
export function syncLegacy(accountId: number, asset: string | null) {
  const account = getAccount(accountId);
  if (!account) return;
  const txs = seriesTx(accountId, asset);
  if (asset == null) {
    const balance = txs.reduce((s, t) => s + t.amount, 0);
    db().prepare("UPDATE cash_accounts SET balance = ?, updated_at = datetime('now') WHERE account_id = ?").run(balance, accountId);
    return;
  }
  const s = replay(txs);
  writePosition(account, asset, s.quantity, s.cost == null || s.quantity === 0 ? null : s.cost / s.quantity);
}

// ---------- comparison ----------

export type Mismatch = { label: string; legacy: string; ledger: string };

const close = (a: number, b: number, abs: number) => Math.abs(a - b) <= Math.max(abs, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 8 });
const money = (n: number | null) => (n == null ? "成本未知" : `成本 ${Math.round(n).toLocaleString("en-US")}`);

/** Differences between the old tables and the ledger; empty when they agree. */
export function compareWithLedger(): Mismatch[] {
  const out: Mismatch[] = [];
  for (const kind of ["stock", "crypto"] as const) {
    const ledger = new Map(ledgerHoldings(kind).map((h) => [`${h.accountId}|${h.asset}`, h]));
    const seen = new Set<string>();
    for (const old of legacyHoldings(kind)) {
      const label = `${old.symbol}（${old.account || "未指定"}）`;
      if (old.accountId == null) {
        out.push({ label, legacy: qty(old.quantity), ledger: "沒有對應的帳本帳戶" });
        continue;
      }
      const k = `${old.accountId}|${old.asset}`;
      seen.add(k);
      const now = ledger.get(k);
      const nowQty = now?.quantity ?? 0;
      if (Math.abs(old.quantity) <= QTY_EPS && Math.abs(nowQty) <= QTY_EPS) continue;
      const costsAgree = (old.cost == null) === (now?.cost == null) && (old.cost == null || close(old.cost, now!.cost!, 0.01));
      if (!close(old.quantity, nowQty, QTY_EPS) || !costsAgree) {
        out.push({ label, legacy: `${qty(old.quantity)}，${money(old.cost)}`, ledger: now ? `${qty(nowQty)}，${money(now.cost)}` : "沒有部位" });
      }
    }
    for (const [k, h] of ledger) {
      if (!seen.has(k)) out.push({ label: `${h.symbol}（${h.account}）`, legacy: "沒有這筆", ledger: `${qty(h.quantity)}，${money(h.cost)}` });
    }
  }

  const ledgerBalances = new Map(ledgerCash().map((c) => [c.accountId, c]));
  const seen = new Set<number>();
  for (const old of legacyCash()) {
    if (old.accountId == null) {
      out.push({ label: old.name, legacy: qty(old.balance), ledger: "沒有對應的帳本帳戶" });
      continue;
    }
    seen.add(old.accountId);
    const now = ledgerBalances.get(old.accountId);
    if (!now || !close(old.balance, now.balance, 0.005)) {
      out.push({ label: old.name, legacy: qty(old.balance), ledger: now ? qty(now.balance) : "沒有這個帳戶" });
    }
  }
  for (const [id, c] of ledgerBalances) if (!seen.has(id!)) out.push({ label: c.name, legacy: "沒有這個帳戶", ledger: qty(c.balance) });
  return out;
}
