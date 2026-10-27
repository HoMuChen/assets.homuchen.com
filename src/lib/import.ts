// Importing a broker's CSV into one stock account: trades become transactions (each row once, however often
// the file is imported); a holdings statement is checked against the ledger and the differences go to the inbox.

import { parseBrokerCsv, type HoldingRow, type RowError, type TradeRow } from "./broker-csv";
import { db, type Account } from "./db";
import { twTradeCosts } from "./fees";
import { reportHolding } from "./inbox";
import { instruments, ledgerHoldings, saveInstrument, seriesAt } from "./ledger";
import { taipeiDate } from "./time";
import { accountByName, addTransaction, LedgerError, recorded } from "./transactions";

export type TradePreview = TradeRow & {
  externalId: string;
  fee: number;
  tax: number;
  /** new: will be added; imported: already in from an earlier import; similar: a hand-entered one looks the same. */
  status: "new" | "imported" | "similar";
};

export type HoldingPreview = HoldingRow & { ledger: number; diff: number };

export type ImportPreview =
  | { kind: "trades"; account: string; rows: TradePreview[]; errors: RowError[]; columns: string[] }
  | { kind: "holdings"; account: string; date: string; rows: HoldingPreview[]; errors: RowError[]; columns: string[] };

const findAccount = (name: string) =>
  db().prepare("SELECT * FROM accounts WHERE kind = 'stock' AND name = ? ORDER BY id LIMIT 1").get(name) as Account | undefined;

/** Read a file against an account (which needn't exist yet) without writing anything. */
export function previewImport(text: string, accountName: string, date: string): ImportPreview {
  const parsed = parseBrokerCsv(text);
  const account = findAccount(accountName);
  if (parsed.kind === "holdings") {
    const rows = parsed.rows.map((h) => {
      const ledger = account ? seriesAt(account.id, `tw:${h.symbol}`, date).quantity : 0;
      return { ...h, ledger, diff: h.quantity - ledger };
    });
    // Holdings the statement doesn't list are holdings the broker says are gone.
    const listed = new Set(rows.map((r) => r.symbol));
    const info = instruments();
    for (const h of account ? ledgerHoldings("stock").filter((x) => x.accountId === account.id) : []) {
      const symbol = info.get(h.asset)?.symbol ?? h.symbol;
      if (listed.has(symbol)) continue;
      const ledger = seriesAt(account!.id, h.asset, date).quantity;
      if (ledger) rows.push({ line: 0, symbol, name: h.name, quantity: 0, avgCost: null, ledger, diff: -ledger });
    }
    return { kind: "holdings", account: accountName, date, rows, errors: parsed.errors, columns: parsed.columns };
  }
  return { kind: "trades", account: accountName, rows: tradeRows(parsed.rows, account), errors: parsed.errors, columns: parsed.columns };
}

function tradeRows(rows: TradeRow[], account: Account | undefined): TradePreview[] {
  // Identical fills on one day are told apart by their order in the file.
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.date}:${r.symbol}:${r.side}:${r.quantity}:${r.price}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const externalId = `${account?.id ?? "new"}:${base}:${n}`;
    const auto = twTradeCosts({ side: r.side, symbol: r.symbol, shares: r.quantity, price: r.price, date: r.date, feeDiscount: account?.fee_discount });
    const fee = r.fee ?? auto.fee;
    const tax = r.tax ?? (r.side === "sell" ? auto.tax : 0);
    let status: TradePreview["status"] = "new";
    if (account && recorded("import", externalId)) status = "imported";
    else if (account && similarManual(account.id, r)) status = "similar";
    return { ...r, externalId, fee, tax, status };
  });
}

const similarManual = (accountId: number, r: TradeRow) =>
  !!db()
    .prepare(
      `SELECT 1 FROM transactions WHERE account_id = ? AND asset = ? AND date = ? AND type = ? AND source = 'manual'
       AND abs(quantity - ?) < 1e-9`,
    )
    .get(accountId, `tw:${r.symbol}`, r.date, r.side, r.side === "buy" ? r.quantity : -r.quantity);

export type ImportResult = { added: number; skipped: number; failed: RowError[]; reported?: number };

/**
 * Write the previewed trades whose line is in `include` (default: the new ones), oldest first and buys before
 * sells within a day, so a day trade's sell finds its shares. Names come from the file or `nameOf`.
 */
export async function importTrades(
  text: string,
  accountName: string,
  include: Set<number> | null,
  nameOf: (symbol: string) => Promise<string | null>,
  now = new Date(),
): Promise<ImportResult> {
  const account = accountByName("stock", accountName, now);
  const preview = previewImport(text, accountName, taipeiDate(now));
  if (preview.kind !== "trades") throw new LedgerError("這個檔案是庫存，不是成交明細");
  const rows = preview.rows
    .filter((r) => r.status !== "imported" && (include ? include.has(r.line) : r.status === "new"))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.side === b.side ? a.line - b.line : a.side === "buy" ? -1 : 1));
  const info = instruments();
  const failed: RowError[] = [];
  let added = 0;
  for (const r of rows) {
    const asset = `tw:${r.symbol}`;
    if (!info.get(asset)?.name) saveInstrument(asset, r.symbol, r.name ?? (await nameOf(r.symbol)));
    const value = r.quantity * r.price;
    try {
      const id = addTransaction(
        {
          accountId: account.id,
          date: r.date,
          type: r.side,
          asset,
          quantity: r.side === "buy" ? r.quantity : -r.quantity,
          price: r.price,
          amount: r.side === "buy" ? -(value + r.fee + r.tax) : value - r.fee - r.tax,
          fee: r.fee,
          tax: r.tax,
          note: null,
          source: "import",
          externalId: r.externalId,
        },
        now,
      );
      if (id != null) added++;
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      failed.push({ line: r.line, message: `${r.symbol} ${r.date}：${e.message}` });
    }
  }
  return { added, skipped: preview.rows.length - added - failed.length, failed: [...preview.errors, ...failed] };
}

/** Report a holdings statement as of `date`; differences from the ledger wait in the inbox. */
export function importHoldings(text: string, accountName: string, date: string, now = new Date()): ImportResult {
  const account = accountByName("stock", accountName, now);
  const preview = previewImport(text, accountName, date);
  if (preview.kind !== "holdings") throw new LedgerError("這個檔案是成交明細，不是庫存");
  let reported = 0;
  for (const r of preview.rows) {
    const asset = `tw:${r.symbol}`;
    if (!instruments().has(asset)) saveInstrument(asset, r.symbol, r.name);
    reportHolding({ accountId: account.id, asset, source: "import", date, observed: r.quantity, detail: `${accountName} 庫存對帳單` }, now);
    if (r.diff) reported++;
  }
  return { added: 0, skipped: 0, failed: preview.errors, reported };
}
