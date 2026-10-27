// Read-only Bybit (V5) sync for one Unified Trading Account. Create the key read-only and bound to the VM's IP;
// set BYBIT_API_KEY / BYBIT_API_SECRET. The futures account whose source is 'bybit' holds all of the account's
// margin stablecoins (MARGIN_COINS, Unified + Funding, counted 1:1 as USDT) and its USDT-margined positions; every
// other coin is spot, held in the crypto account whose source is 'bybit'.
//
//  - balances (every minute): wallet, positions, mark and liquidation prices, margin rate (src/lib/monitor.ts
//    watches them);
//  - records (every 10 minutes): the margin coins' transaction log, deposits and withdrawals into the futures
//    account's ledger; spot fills into the crypto account; coin deposits and withdrawals into the inbox to be
//    confirmed; then each holding is checked against the balances (src/lib/inbox.ts).
//
// Records from before an account was linked are left out: its holdings at that moment are the starting point.

import crypto from "node:crypto";
import { db, type Account, type FuturesAccount, type FuturesPosition, type TxType } from "./db";
import { addRecord, reportHolding, retryAuto } from "./inbox";
import { recordRun } from "./jobs";
import { getAccount, instruments, ledgerHoldings, saveInstrument } from "./ledger";
import { coinPricesTwd, resolveCoin } from "./prices";
import { getSetting, setSetting } from "./settings";
import { taipeiDate } from "./time";
import { addTransaction, LedgerError, type TxInput } from "./transactions";
import { assetId } from "./tx";

const BASE_URL = () => process.env.BYBIT_BASE_URL || "https://api.bybit.com";
const RECV_WINDOW = "10000";
const DAY = 86_400_000;
/** Records are read again from this long before the last read: the exchange can post one a little late. */
const OVERLAP_MS = 60 * 60_000;
/** Bybit keeps fills and the transaction log for two years. */
const HISTORY_MS = 729 * DAY;

/**
 * The futures wallet: Bybit takes both as margin for USDT perpetuals. USDC is counted 1:1 as USDT, so the
 * ledger adds up in units; the two rarely drift more than 0.1% apart.
 */
export const MARGIN_COINS = ["USDT", "USDC"];
const isMargin = (coin: string) => MARGIN_COINS.includes(coin.toUpperCase());

export const bybitConfigured = () => !!process.env.BYBIT_API_KEY && !!process.env.BYBIT_API_SECRET;

// ---------- API ----------

type Params = Record<string, string | number | undefined>;

const HINT: Record<number, string> = {
  10002: "伺服器時間和 Bybit 差太多",
  10003: "API key 無效",
  10004: "簽名錯誤，請檢查 API secret",
  10005: "API key 缺少權限，需要唯讀的「合約」「現貨」「資產」",
  10010: "這個 IP 不在 API key 的白名單",
};

/** One V5 GET; `signed` adds the HMAC headers. Errors carry Bybit's code and message. */
async function get<T>(path: string, params: Params = {}, signed = true): Promise<T> {
  const qs = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [[k, String(v)]])),
  ).toString();
  const headers: Record<string, string> = {};
  if (signed) {
    const key = process.env.BYBIT_API_KEY ?? "";
    const ts = String(Date.now());
    headers["X-BAPI-API-KEY"] = key;
    headers["X-BAPI-TIMESTAMP"] = ts;
    headers["X-BAPI-RECV-WINDOW"] = RECV_WINDOW;
    headers["X-BAPI-SIGN"] = sign(ts, key, qs);
  }
  const res = await fetch(`${BASE_URL()}${path}${qs ? `?${qs}` : ""}`, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (res.status === 403) throw new Error("403：Bybit 拒絕這個 IP（不接受美國、中國大陸的 IP）");
  const body = (await res.json().catch(() => null)) as { retCode: number; retMsg: string; result: T } | null;
  if (!body) throw new Error(`${res.status} ${res.statusText}`);
  if (body.retCode !== 0) throw new Error(`${body.retCode} ${body.retMsg}${HINT[body.retCode] ? `（${HINT[body.retCode]}）` : ""}`);
  return body.result;
}

/** HMAC-SHA256 of timestamp + key + recv window + query string, hex. */
export function sign(ts: string, key: string, qs: string): string {
  return crypto
    .createHmac("sha256", process.env.BYBIT_API_SECRET ?? "")
    .update(ts + key + RECV_WINDOW + qs)
    .digest("hex");
}

/** Every page of a cursor-paginated list. */
async function pages<T>(path: string, params: Params, key: "list" | "rows" = "list"): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const r = await get<Record<string, unknown>>(path, { ...params, cursor });
    out.push(...((r[key] as T[] | undefined) ?? []));
    cursor = (r.nextPageCursor as string | undefined) || undefined;
    if (!cursor) break;
  }
  return out;
}

/** [from, to) in spans of at most `span` ms (most history endpoints take 7 days per request). */
function spans(from: number, to: number, span: number): [number, number][] {
  const out: [number, number][] = [];
  for (let a = from; a < to; a += span) out.push([a, Math.min(to, a + span)]);
  return out;
}

/** Bybit sends numbers as strings, "" when not applicable. */
const num = (s: string | number | null | undefined) => {
  const n = Number(s);
  return s === "" || s == null || !Number.isFinite(n) ? 0 : n;
};
const optNum = (s: string | null | undefined) => (num(s) ? num(s) : null);
/** Timestamps are milliseconds on most endpoints and seconds on a few. */
const ms = (t: string | number) => (num(t) < 1e12 ? num(t) * 1000 : num(t));

type WalletCoin = { coin: string; walletBalance: string; spotBorrow?: string };
type LinearPosition = {
  symbol: string;
  side: "Buy" | "Sell" | "";
  size: string;
  avgPrice: string;
  markPrice: string;
  liqPrice: string;
  leverage: string;
  unrealisedPnl: string;
};
export type LogEntry = {
  id: string;
  symbol: string;
  category: string;
  side: string;
  transactionTime: string;
  type: string;
  currency: string;
  cashFlow: string;
  fee: string;
  change: string;
};
export type Fill = {
  symbol: string;
  side: "Buy" | "Sell";
  execPrice: string;
  execQty: string;
  execValue: string;
  execFee: string;
  feeCurrency: string;
  execTime: string;
  execId: string;
  execType: string;
};

// ---------- coins ----------

const WELL_KNOWN: Record<string, string> = { USDT: "tether", USDC: "usd-coin", BTC: "bitcoin", ETH: "ethereum" };

/** CoinGecko id for an exchange ticker: what the ledger already calls it, else CoinGecko's best match. */
async function coinId(symbol: string, memo: Map<string, string>): Promise<string> {
  const sym = symbol.toUpperCase();
  const hit = memo.get(sym);
  if (hit) return hit;
  const known = db().prepare("SELECT asset FROM instruments WHERE asset LIKE 'crypto:%' AND upper(symbol) = ? ORDER BY asset LIMIT 1").get(sym) as
    | { asset: string }
    | undefined;
  let id = WELL_KNOWN[sym] ?? (known ? assetId(known.asset) : null);
  if (!id) {
    const coin = await resolveCoin(sym).catch(() => null);
    id = coin?.id ?? sym.toLowerCase();
    if (coin) saveInstrument(`crypto:${coin.id}`, sym, coin.name);
  }
  if (!known) saveInstrument(`crypto:${id}`, sym, null);
  memo.set(sym, id);
  return id;
}

/** 'BTCUSDT' → BTC × 1; '1000PEPEUSDT' → PEPE × 1000: the contract counts and prices 1,000 coins as one. */
export function linearBase(symbol: string): { coin: string; multiplier: number } {
  const base = symbol.replace(/USDT$/, "");
  const pre = base.match(/^(10{1,6})(?=[A-Z])/);
  if (pre) return { coin: base.slice(pre[1].length), multiplier: Number(pre[1]) };
  const post = base.match(/^([A-Z0-9]+?)(10{3,6})$/);
  if (post) return { coin: post[1], multiplier: Number(post[2]) };
  return { coin: base, multiplier: 1 };
}

const g = globalThis as unknown as { __bybitPairs?: Map<string, { base: string; quote: string }> };

/** Base and quote coin of a spot pair (public endpoint, cached for the process). */
async function spotPair(symbol: string): Promise<{ base: string; quote: string }> {
  const cache = (g.__bybitPairs ??= new Map());
  const hit = cache.get(symbol);
  if (hit) return hit;
  const r = await get<{ list: { baseCoin: string; quoteCoin: string }[] }>("/v5/market/instruments-info", { category: "spot", symbol }, false);
  const info = r.list[0];
  if (!info) throw new Error(`找不到現貨交易對 ${symbol}`);
  const pair = { base: info.baseCoin.toUpperCase(), quote: info.quoteCoin.toUpperCase() };
  cache.set(symbol, pair);
  return pair;
}

// ---------- balances ----------

export type Balances = {
  /** Units per coin, Unified + Funding, net of borrowing. */
  coins: Map<string, number>;
  /** Margin coins, Unified + Funding; the futures wallet. */
  margin: number;
  /** The part of `margin` in the Funding account. */
  marginFund: number;
  /** Maintenance margin ÷ margin balance, %; Bybit liquidates at 100. */
  marginRate: number | null;
  positions: LinearPosition[];
};

async function fetchBalances(): Promise<Balances> {
  const [wallet, fund, positions] = await Promise.all([
    get<{ list: { accountMMRate: string; coin: WalletCoin[] }[] }>("/v5/account/wallet-balance", { accountType: "UNIFIED" }),
    get<{ balance: { coin: string; walletBalance: string }[] }>("/v5/asset/transfer/query-account-coins-balance", { accountType: "FUND" }),
    pages<LinearPosition>("/v5/position/list", { category: "linear", settleCoin: "USDT", limit: 200 }),
  ]);
  const coins = new Map<string, number>();
  const add = (coin: string, n: number) => {
    if (n) coins.set(coin.toUpperCase(), (coins.get(coin.toUpperCase()) ?? 0) + n);
  };
  const margin = () => MARGIN_COINS.reduce((sum, c) => sum + (coins.get(c) ?? 0), 0);
  const unified = wallet.list[0];
  for (const c of unified?.coin ?? []) add(c.coin, num(c.walletBalance) - num(c.spotBorrow));
  const marginUnified = margin();
  for (const c of fund.balance ?? []) add(c.coin, num(c.walletBalance));
  return {
    coins,
    margin: margin(),
    marginFund: margin() - marginUnified,
    marginRate: unified?.accountMMRate ? num(unified.accountMMRate) * 100 : null,
    positions: positions.filter((p) => num(p.size) > 0),
  };
}

async function applyBalances(fa: FuturesAccount, b: Balances, memo: Map<string, string>, now: Date) {
  const names = instruments();
  const rows: Omit<FuturesPosition, "id">[] = [];
  for (const p of b.positions) {
    const { coin, multiplier } = linearBase(p.symbol);
    const id = await coinId(coin, memo);
    rows.push({
      account_id: fa.id,
      coin_id: id,
      symbol: coin,
      name: names.get(`crypto:${id}`)?.name ?? null,
      side: p.side === "Sell" ? ("short" as const) : ("long" as const),
      quantity: num(p.size) * multiplier,
      entry_price: num(p.avgPrice) / multiplier,
      leverage: optNum(p.leverage),
      note: multiplier > 1 ? p.symbol : null,
      mark_price: num(p.markPrice) / multiplier,
      liq_price: optNum(p.liqPrice) == null ? null : num(p.liqPrice) / multiplier,
      upnl: num(p.unrealisedPnl),
    });
  }
  db().transaction(() => {
    db()
      .prepare(
        `UPDATE futures_accounts SET wallet_balance = ?, fund_balance = ?, margin_rate = ?, synced_at = ?, sync_error = NULL,
         updated_at = datetime('now') WHERE id = ?`,
      )
      .run(b.margin, b.marginFund, b.marginRate, now.toISOString(), fa.id);
    db().prepare("DELETE FROM futures_positions WHERE account_id = ?").run(fa.id);
    const insert = db().prepare(
      `INSERT INTO futures_positions (account_id, coin_id, symbol, name, side, quantity, entry_price, leverage, note, mark_price, liq_price, upnl)
       VALUES (@account_id, @coin_id, @symbol, @name, @side, @quantity, @entry_price, @leverage, @note, @mark_price, @liq_price, @upnl)`,
    );
    rows.forEach((r) => insert.run(r));
  })();
}

// ---------- records ----------

/** start: records before it are already in the opening balance; done: read up to here. Epoch ms. */
type Cursor = { start: number; done: number };

const cursorKey = (name: string) => `bybit:cursor:${name}`;
function readCursor(name: string): Cursor | null {
  const v = getSetting(cursorKey(name));
  return v ? (JSON.parse(v) as Cursor) : null;
}
const writeCursor = (name: string, c: Cursor, now: Date) => setSetting(cursorKey(name), JSON.stringify(c), now);
export const forgetCursor = (name: string) => db().prepare("DELETE FROM settings WHERE key = ?").run(cursorKey(name));

const since = (c: Cursor, now: number) => Math.max(c.start, c.done - OVERLAP_MS, now - HISTORY_MS);

async function fetchLog(c: Cursor, now: number): Promise<LogEntry[]> {
  const out: LogEntry[] = [];
  for (const currency of MARGIN_COINS) {
    for (const [a, b] of spans(since(c, now), now, 7 * DAY)) {
      out.push(...(await pages<LogEntry>("/v5/account/transaction-log", { accountType: "UNIFIED", currency, startTime: a, endTime: b, limit: 50 })));
    }
  }
  return out.filter((e) => ms(e.transactionTime) >= c.start);
}

async function fetchFills(c: Cursor, now: number): Promise<Fill[]> {
  const out: Fill[] = [];
  for (const [a, b] of spans(since(c, now), now, 7 * DAY)) {
    out.push(...(await pages<Fill>("/v5/execution/list", { category: "spot", startTime: a, endTime: b, limit: 100 })));
  }
  return out.filter((f) => f.execType === "Trade" && ms(f.execTime) >= c.start).sort((x, y) => ms(x.execTime) - ms(y.execTime));
}

/** A completed deposit or withdrawal of any coin. quantity is signed and includes the network fee. */
export type Flow = { key: string; coin: string; quantity: number; networkFee: number; time: number; detail: string };

/** Deposits and withdrawals of the last 29 days (each list takes at most 30 days per request). */
async function fetchFlows(now: number): Promise<Flow[]> {
  const range = { startTime: now - 29 * DAY, endTime: now, limit: 50 };
  const [chain, internal, out] = await Promise.all([
    pages<{ id: string; txID: string; coin: string; chain: string; amount: string; status: number; successAt: string }>(
      "/v5/asset/deposit/query-record",
      range,
      "rows",
    ),
    pages<{ id: string; coin: string; amount: string; status: number; createdTime: string }>("/v5/asset/deposit/query-internal-record", range, "rows"),
    pages<{ withdrawId: string; coin: string; chain: string; amount: string; withdrawFee: string; status: string; createTime: string; updateTime: string; withdrawType: number }>(
      "/v5/asset/withdraw/query-record",
      { ...range, withdrawType: 2 },
      "rows",
    ),
  ]);
  return [
    ...chain
      .filter((d) => Number(d.status) === 3)
      .map((d) => ({ key: `bybit:deposit:${d.id || d.txID}`, coin: d.coin.toUpperCase(), quantity: num(d.amount), networkFee: 0, time: ms(d.successAt), detail: `鏈上入金（${d.chain}）` })),
    ...internal
      .filter((d) => Number(d.status) === 2)
      .map((d) => ({ key: `bybit:internal:${d.id}`, coin: d.coin.toUpperCase(), quantity: num(d.amount), networkFee: 0, time: ms(d.createdTime), detail: "站內轉入" })),
    ...out
      .filter((w) => w.status === "success")
      .map((w) => ({
        key: `bybit:withdraw:${w.withdrawId}`,
        coin: w.coin.toUpperCase(),
        quantity: -(num(w.amount) + num(w.withdrawFee)),
        networkFee: num(w.withdrawFee),
        time: ms(w.updateTime || w.createTime),
        detail: Number(w.withdrawType) === 1 ? "站內轉出" : `鏈上提領（${w.chain}）`,
      })),
  ];
}

const dateOf = (t: number) => taipeiDate(new Date(t));

/** One entry of a margin coin's transaction log as a ledger transaction; null for what isn't a balance change. */
export function logEntryTx(e: LogEntry, accountId: number): TxInput | null {
  const amount = num(e.change);
  if (!amount) return null;
  const side = e.side === "Buy" ? " 買" : e.side === "Sell" ? " 賣" : "";
  const as = (type: TxType, note: string): TxInput => ({
    accountId,
    date: dateOf(ms(e.transactionTime)),
    type,
    asset: null,
    quantity: 0,
    price: null,
    amount,
    fee: e.type === "TRADE" ? num(e.fee) : 0,
    tax: 0,
    note,
    source: "bybit",
    // Bybit's id alone isn't unique across a trade's fee and funding entries.
    externalId: `bybit:log:${e.id}|${e.type}|${e.currency}|${e.transactionTime}|${e.change}`,
  });
  switch (e.type) {
    // Funding ↔ Unified: both are this wallet. Money from outside comes in through the deposit records.
    case "TRANSFER_IN":
    case "TRANSFER_OUT":
      return null;
    case "TRADE":
      return e.category === "spot"
        ? as("transfer", `現貨 ${e.symbol}${side}`)
        : as(num(e.cashFlow) ? "pnl" : "fee", `${e.symbol}${side}`);
    case "SETTLEMENT":
      return as("funding", e.symbol);
    case "LIQUIDATION":
    case "ADL":
    case "DELIVERY":
      return as("pnl", `${e.symbol} ${e.type}`);
    case "INTEREST":
      return as("fee", "借款利息");
    case "FEE_REFUND":
      return as("fee", "手續費退還");
    case "CURRENCY_BUY":
    case "CURRENCY_SELL":
    case "CONVERT":
    case "SPOT_REPAYMENT_BUY":
    case "SPOT_REPAYMENT_SELL":
      return as("transfer", e.type);
    default:
      return as("adjust", e.type);
  }
}

/**
 * A spot fill as ledger transactions in TWD. The base coin is bought or sold at the fill price times the quote
 * coin's TWD price; a fee taken in the base coin comes out of the units. The quote coin's own leg is included
 * unless `quoteElsewhere` (a margin coin, which the futures wallet's log already records).
 */
export function fillLegs(
  f: Fill,
  pair: { base: string; quote: string },
  ids: { base: string; quote: string },
  twd: Map<string, number>,
  accountId: number,
  quoteElsewhere: boolean,
): TxInput[] {
  const q = num(f.execQty);
  const value = num(f.execValue);
  const fee = num(f.execFee);
  const feeCoin = (f.feeCurrency || pair.quote).toUpperCase();
  const quoteTwd = twd.get(pair.quote) ?? null;
  const price = quoteTwd == null ? null : num(f.execPrice) * quoteTwd;
  const feeBase = feeCoin === pair.base ? fee : 0;
  const feeQuote = feeCoin === pair.quote ? fee : 0;
  const feeTwd = feeCoin === pair.base ? fee * (price ?? 0) : fee * (twd.get(feeCoin) ?? 0);
  const rate = quoteTwd ?? 0;
  const buy = f.side === "Buy";
  const common = { accountId, date: dateOf(ms(f.execTime)), tax: 0, note: `Bybit ${f.symbol} ${buy ? "買進" : "賣出"} @ ${f.execPrice}`, source: "bybit" };
  const legs: TxInput[] = [
    buy
      ? { ...common, type: "buy", asset: `crypto:${ids.base}`, quantity: q - feeBase, price, amount: -(value + feeQuote) * rate, fee: feeTwd, externalId: `bybit:fill:${f.execId}` }
      : { ...common, type: "sell", asset: `crypto:${ids.base}`, quantity: -(q + feeBase), price, amount: (value - feeQuote) * rate, fee: feeTwd, externalId: `bybit:fill:${f.execId}` },
  ];
  if (!quoteElsewhere) {
    const units = buy ? -(value + feeQuote) : value - feeQuote;
    legs.push({
      ...common,
      type: buy ? "sell" : "buy",
      asset: `crypto:${ids.quote}`,
      quantity: units,
      price: quoteTwd,
      amount: -units * rate,
      fee: 0,
      externalId: `bybit:fill:${f.execId}:quote`,
    });
  }
  return legs;
}

const dismissed = (key: string) => !!db().prepare("SELECT 1 FROM inbox WHERE key = ? AND status = 'dismissed'").get(key);

/** Write a synced transaction; one the ledger can't take yet (a sell ahead of its holding) waits in the inbox. */
function applySynced(t: TxInput, title: string, now: Date) {
  if (dismissed(t.externalId!)) return;
  try {
    addTransaction(t, now);
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    addRecord(
      { key: t.externalId!, accountId: t.accountId, asset: t.asset, source: "bybit", date: t.date, type: t.type, quantity: t.quantity, price: t.price, amount: t.amount, fee: t.fee, title, auto: true, error: e.message },
      now,
    );
  }
}

/** The futures account's ledger account, opened at today's margin balance the first time it syncs. */
function futuresLedger(fa: FuturesAccount, b: Balances, now: Date): { account: Account; cursor: Cursor } | null {
  const existing = fa.account_id ? getAccount(fa.account_id) : undefined;
  if (existing) return { account: existing, cursor: readCursor(`futures:${existing.id}`) ?? { start: now.getTime(), done: now.getTime() } };
  db().transaction(() => {
    const at = now.toISOString();
    const r = db()
      .prepare("INSERT INTO accounts (kind, name, institution, currency, source, created_at, updated_at) VALUES ('futures', ?, 'Bybit', 'USDT', 'bybit', ?, ?)")
      .run(fa.name, at, at);
    const id = Number(r.lastInsertRowid);
    addTransaction(
      { accountId: id, date: taipeiDate(now), type: "open", asset: null, quantity: 0, price: null, amount: b.margin, fee: 0, tax: 0, note: "開始同步時的保證金餘額（USDT＋USDC）" },
      now,
    );
    db().prepare("UPDATE futures_accounts SET account_id = ? WHERE id = ?").run(id, fa.id);
    writeCursor(`futures:${id}`, { start: now.getTime(), done: now.getTime() }, now);
  })();
  return null; // nothing to read yet
}

function linked() {
  return {
    futures: db().prepare("SELECT * FROM futures_accounts WHERE source = 'bybit' ORDER BY id LIMIT 1").get() as FuturesAccount | undefined,
    spot: db().prepare("SELECT * FROM accounts WHERE kind = 'crypto' AND source = 'bybit' ORDER BY id LIMIT 1").get() as Account | undefined,
  };
}

// ---------- the sync ----------

export type SyncMode = "balances" | "full";
export type SyncResult = { synced: boolean; error: string | null };

const queue = globalThis as unknown as { __bybitTail?: Promise<unknown>; __bybitWaiting?: Map<SyncMode, Promise<SyncResult>> };

/** One sync at a time, in order; asking for one that is already waiting to start shares it. */
export function syncBybit(mode: SyncMode = "balances"): Promise<SyncResult> {
  const waiting = (queue.__bybitWaiting ??= new Map());
  const w = waiting.get(mode);
  if (w) return w;
  const p = (queue.__bybitTail ?? Promise.resolve()).then(() => {
    waiting.delete(mode);
    return runSync(mode);
  });
  waiting.set(mode, p);
  queue.__bybitTail = p.catch(() => {});
  return p;
}

export async function runSync(mode: SyncMode, now = new Date()): Promise<SyncResult> {
  const { futures, spot } = linked();
  let fa = futures;
  if (!bybitConfigured() || (!fa && !spot)) return { synced: false, error: null };
  const memo = new Map<string, string>();
  const t = now.getTime();
  try {
    // Records first, then the balances they should add up to.
    const futuresCursor = fa?.account_id ? readCursor(`futures:${fa.account_id}`) : null;
    const spotCursor = spot ? (readCursor(`spot:${spot.id}`) ?? { start: t, done: t }) : null;
    const log = mode === "full" && futuresCursor ? await fetchLog(futuresCursor, t) : [];
    const fills = mode === "full" && spotCursor ? await fetchFills(spotCursor, t) : [];
    const flows = mode === "full" ? await fetchFlows(t) : [];
    const b = await fetchBalances();

    if (fa) {
      await applyBalances(fa, b, memo, now);
      fa = db().prepare("SELECT * FROM futures_accounts WHERE id = ?").get(fa.id) as FuturesAccount;
    }
    if (mode === "full" && fa) {
      const ledger = futuresLedger(fa, b, now);
      if (ledger) {
        const { account, cursor } = ledger;
        db().transaction(() => {
          for (const e of log) {
            const tx = logEntryTx(e, account.id);
            if (tx) addTransaction(tx, now);
          }
          for (const f of flows.filter((x) => isMargin(x.coin) && x.time >= cursor.start)) {
            addTransaction(
              { accountId: account.id, date: dateOf(f.time), type: f.quantity > 0 ? "deposit" : "withdraw", asset: null, quantity: 0, price: null, amount: f.quantity, fee: f.networkFee, tax: 0, note: f.detail, source: "bybit", externalId: f.key },
              now,
            );
          }
        })();
        writeCursor(`futures:${account.id}`, { ...cursor, done: t }, now);
        reportHolding({ accountId: account.id, asset: null, source: "bybit", date: taipeiDate(now), observed: b.margin }, now);
      }
    }
    if (mode === "full" && spot && spotCursor) await syncSpot(spot, spotCursor, b, fills, flows, !!fa, memo, now);
    recordRun("sync:bybit", null, now);
    return { synced: true, error: null };
  } catch (e) {
    const msg = `Bybit API：${(e as Error).message}`;
    db().prepare("UPDATE futures_accounts SET sync_error = ? WHERE source = 'bybit'").run(msg);
    recordRun("sync:bybit", msg, now);
    return { synced: false, error: msg };
  }
}

async function syncSpot(
  account: Account,
  cursor: Cursor,
  b: Balances,
  fills: Fill[],
  flows: Flow[],
  futuresLinked: boolean,
  memo: Map<string, string>,
  now: Date,
) {
  // The margin coins are the futures wallet when one is linked.
  const isSpot = (coin: string) => !futuresLinked || !isMargin(coin);
  const pairs = new Map<string, { base: string; quote: string }>();
  for (const f of fills) if (!pairs.has(f.symbol)) pairs.set(f.symbol, await spotPair(f.symbol));
  const coins = new Set([...pairs.values()].flatMap((p) => [p.base, p.quote]));
  for (const f of fills) if (f.feeCurrency) coins.add(f.feeCurrency.toUpperCase());
  const ids = new Map<string, string>();
  for (const c of coins) ids.set(c, await coinId(c, memo));
  const prices = await coinPricesTwd([...ids.values()]);
  const twd = new Map([...ids].flatMap(([c, id]) => (prices.has(id) ? [[c, prices.get(id)!] as const] : [])));

  for (const f of fills) {
    const pair = pairs.get(f.symbol)!;
    for (const leg of fillLegs(f, pair, { base: ids.get(pair.base)!, quote: ids.get(pair.quote)! }, twd, account.id, !isSpot(pair.quote))) {
      applySynced(leg, leg.note!, now);
    }
  }

  for (const f of flows.filter((x) => isSpot(x.coin) && x.time >= cursor.start)) {
    const id = await coinId(f.coin, memo);
    const price = f.quantity > 0 ? ((await coinPricesTwd([id])).get(id) ?? null) : null;
    const units = Math.abs(f.quantity).toLocaleString("en-US", { maximumFractionDigits: 8 });
    addRecord(
      {
        key: f.key,
        accountId: account.id,
        asset: `crypto:${id}`,
        source: "bybit",
        date: dateOf(f.time),
        type: f.quantity > 0 ? "deposit" : "withdraw",
        quantity: f.quantity,
        price,
        amount: 0,
        networkFee: f.networkFee,
        title: `${f.quantity > 0 ? "收到" : "提出"} ${units} ${f.coin}`,
        detail: `${f.detail}${f.networkFee ? `，手續費 ${f.networkFee} ${f.coin}` : ""}`,
      },
      now,
    );
  }
  retryAuto(now);

  // Every coin either side knows about: what Bybit holds against the ledger.
  const observed = new Map<string, number>();
  for (const [coin, units] of b.coins) if (isSpot(coin)) observed.set(`crypto:${await coinId(coin, memo)}`, units);
  for (const h of ledgerHoldings("crypto")) if (h.accountId === account.id && !observed.has(h.asset)) observed.set(h.asset, 0);
  const date = taipeiDate(now);
  for (const [asset, units] of observed) reportHolding({ accountId: account.id, asset, source: "bybit", date, observed: units }, now);
  writeCursor(`spot:${account.id}`, { ...cursor, done: now.getTime() }, now);
}

// ---------- for /status ----------

export function bybitStatus() {
  const { futures, spot } = linked();
  return {
    configured: bybitConfigured(),
    futures: futures ?? null,
    spot: spot ?? null,
    pendingFills: (db().prepare("SELECT COUNT(*) AS n FROM inbox WHERE auto = 1 AND status = 'open'").get() as { n: number }).n,
  };
}
