import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { at, holding, insert, mockFetch, resetDb, setPrice } from "@/test/helpers";
import { bybitStatus, fillLegs, linearBase, logEntryTx, runSync, sign, syncBybit, type Fill, type LogEntry } from "./bybit";
import { db, type Account, type FuturesAccount, type FuturesPosition, type InboxItem, type Transaction } from "./db";
import { acceptItem, openItems } from "./inbox";
import { getRuns } from "./jobs";
import { saveInstrument, seriesAt } from "./ledger";

beforeEach(resetDb);

const T0 = at("2026-10-27 12:00");
const T1 = at("2026-10-27 12:10");
const T2 = at("2026-10-27 12:40");
const inMin = (t: Date, min: number) => String(t.getTime() + min * 60_000);

const log = (fields: Partial<LogEntry>): LogEntry => ({
  id: "1",
  symbol: "BTCUSDT",
  category: "linear",
  side: "Sell",
  transactionTime: inMin(T0, 1),
  type: "TRADE",
  currency: "USDT",
  cashFlow: "0",
  fee: "0",
  change: "0",
  ...fields,
});

const fill = (fields: Partial<Fill>): Fill => ({
  symbol: "BTCUSDT",
  side: "Buy",
  execPrice: "60000",
  execQty: "0.1",
  execValue: "6000",
  execFee: "0.0001",
  feeCurrency: "BTC",
  execTime: inMin(T0, 1),
  execId: "e1",
  execType: "Trade",
  ...fields,
});

describe("sign", () => {
  it("is the HMAC-SHA256 of timestamp, key, receive window and query", () => {
    vi.stubEnv("BYBIT_API_SECRET", "s3cret");
    const expected = crypto.createHmac("sha256", "s3cret").update("1700000000000k10000accountType=UNIFIED").digest("hex");
    expect(sign("1700000000000", "k", "accountType=UNIFIED")).toBe(expected);
  });
});

describe("linearBase", () => {
  it("unpacks contracts quoted per 1,000 coins", () => {
    expect(linearBase("BTCUSDT")).toEqual({ coin: "BTC", multiplier: 1 });
    expect(linearBase("1000PEPEUSDT")).toEqual({ coin: "PEPE", multiplier: 1000 });
    expect(linearBase("10000SATSUSDT")).toEqual({ coin: "SATS", multiplier: 10000 });
    expect(linearBase("SHIB1000USDT")).toEqual({ coin: "SHIB", multiplier: 1000 });
    expect(linearBase("1INCHUSDT")).toEqual({ coin: "1INCH", multiplier: 1 });
  });
});

describe("logEntryTx", () => {
  it("turns the USDT wallet's log into ledger entries, by what each one is", () => {
    const as = (e: Partial<LogEntry>) => logEntryTx(log(e), 7);
    expect(as({ cashFlow: "-50", fee: "1.5", change: "-51.5" })).toMatchObject({
      accountId: 7,
      date: "2026-10-27",
      type: "pnl",
      amount: -51.5,
      fee: 1.5,
      note: "BTCUSDT 賣",
      source: "bybit",
    });
    expect(as({ fee: "2", change: "-2", side: "Buy" })).toMatchObject({ type: "fee", amount: -2, note: "BTCUSDT 買" });
    expect(as({ category: "spot", change: "-6000" })).toMatchObject({ type: "transfer", note: "現貨 BTCUSDT 賣" });
    expect(as({ type: "SETTLEMENT", change: "-0.8" })).toMatchObject({ type: "funding", fee: 0, note: "BTCUSDT" });
    expect(as({ type: "LIQUIDATION", change: "-300" })).toMatchObject({ type: "pnl", note: "BTCUSDT LIQUIDATION" });
    expect(as({ type: "INTEREST", change: "-0.1" })).toMatchObject({ type: "fee", note: "借款利息" });
    expect(as({ type: "FEE_REFUND", change: "0.3" })).toMatchObject({ type: "fee", amount: 0.3 });
    expect(as({ type: "CONVERT", change: "10" })).toMatchObject({ type: "transfer" });
    expect(as({ type: "AIRDROP", change: "5" })).toMatchObject({ type: "adjust", note: "AIRDROP" });
  });

  it("leaves out internal transfers and entries that change nothing", () => {
    expect(logEntryTx(log({ type: "TRANSFER_IN", change: "100" }), 7)).toBeNull();
    expect(logEntryTx(log({ type: "TRANSFER_OUT", change: "-100" }), 7)).toBeNull();
    expect(logEntryTx(log({ change: "0" }), 7)).toBeNull();
  });

  it("gives entries sharing Bybit's id ids of their own", () => {
    const a = logEntryTx(log({ cashFlow: "-50", change: "-50" }), 7)!;
    const b = logEntryTx(log({ type: "SETTLEMENT", change: "-1" }), 7)!;
    expect(a.externalId).not.toBe(b.externalId);
  });
});

describe("fillLegs", () => {
  const twd = new Map([
    ["USDT", 32],
    ["BTC", 1_920_000],
  ]);
  const pair = { base: "BTC", quote: "USDT" };
  const ids = { base: "bitcoin", quote: "tether" };

  it("buys the base coin at the fill price in TWD, the fee in coins coming out of the units", () => {
    const legs = fillLegs(fill({}), pair, ids, twd, 3, true);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ type: "buy", asset: "crypto:bitcoin", price: 1_920_000, amount: -192_000, externalId: "bybit:fill:e1" });
    expect(legs[0].quantity).toBeCloseTo(0.0999, 10);
    expect(legs[0].fee).toBeCloseTo(192, 6);
  });

  it("includes the quote coin's leg when the spot account holds it", () => {
    const legs = fillLegs(fill({ side: "Sell", execFee: "6", feeCurrency: "USDT" }), pair, ids, twd, 3, false);
    expect(legs).toMatchObject([
      { type: "sell", asset: "crypto:bitcoin", quantity: -0.1, amount: 5994 * 32, fee: 6 * 32 },
      { type: "buy", asset: "crypto:tether", quantity: 5994, price: 32, amount: -5994 * 32, externalId: "bybit:fill:e1:quote" },
    ]);
  });

  it("leaves the cost unknown without the quote coin's price", () => {
    expect(fillLegs(fill({}), pair, ids, new Map(), 3, true)[0]).toMatchObject({ price: null, amount: -0 });
  });
});

// ---------- the sync, against a stand-in API ----------

type Api = {
  mmr: string;
  unified: { coin: string; walletBalance: string; spotBorrow?: string }[];
  fund: { coin: string; walletBalance: string }[];
  positions: Record<string, string>[];
  log: LogEntry[];
  fills: Fill[];
  deposits: Record<string, string | number>[];
  internal: Record<string, string | number>[];
  withdrawals: Record<string, string | number>[];
};

function bybitApi(api: Api, fail?: { status?: number; retCode?: number; retMsg?: string }) {
  vi.stubEnv("BYBIT_API_KEY", "key");
  vi.stubEnv("BYBIT_API_SECRET", "secret");
  const headers: Record<string, string>[] = [];
  const ok = (result: unknown) => Response.json({ retCode: 0, retMsg: "OK", result });
  const route = (path: string, body: (url: URL) => unknown) =>
    [
      path,
      (url: URL, init?: RequestInit) => {
        headers.push({ ...(init?.headers as Record<string, string>) });
        if (fail?.status) return new Response("Forbidden", { status: fail.status });
        if (fail?.retCode) return Response.json({ retCode: fail.retCode, retMsg: fail.retMsg ?? "error", result: {} });
        return ok(body(url));
      },
    ] as const;
  const calls = mockFetch([
    route("/v5/account/wallet-balance", () => ({ list: [{ accountMMRate: api.mmr, coin: api.unified }] })),
    route("/v5/asset/transfer/query-account-coins-balance", () => ({ balance: api.fund })),
    route("/v5/position/list", () => ({ list: api.positions, nextPageCursor: "" })),
    route("/v5/account/transaction-log", (url) => ({ list: api.log.filter((e) => e.currency === url.searchParams.get("currency")), nextPageCursor: "" })),
    route("/v5/execution/list", () => ({ list: api.fills, nextPageCursor: "" })),
    route("/v5/asset/deposit/query-record", () => ({ rows: api.deposits, nextPageCursor: "" })),
    route("/v5/asset/deposit/query-internal-record", () => ({ rows: api.internal, nextPageCursor: "" })),
    route("/v5/asset/withdraw/query-record", () => ({ rows: api.withdrawals, nextPageCursor: "" })),
    ["/v5/market/instruments-info", () => ok({ list: [{ baseCoin: "BTC", quoteCoin: "USDT" }] })],
  ]);
  return { calls, headers };
}

const emptyApi = (): Api => ({ mmr: "0.1234", unified: [], fund: [], positions: [], log: [], fills: [], deposits: [], internal: [], withdrawals: [] });

const futuresAccount = () => db().prepare("SELECT * FROM futures_accounts").get() as FuturesAccount;
const positions = () => db().prepare("SELECT * FROM futures_positions ORDER BY id").all() as FuturesPosition[];
const futuresLedger = () => db().prepare("SELECT * FROM accounts WHERE kind = 'futures'").get() as Account | undefined;
const txs = (accountId: number) => db().prepare("SELECT * FROM transactions WHERE account_id = ? ORDER BY id").all(accountId) as Transaction[];
const inbox = () => db().prepare("SELECT * FROM inbox ORDER BY id").all() as InboxItem[];

function linkFutures() {
  return insert("futures_accounts", { name: "Bybit UTA", wallet_balance: 0, source: "bybit" });
}

function linkSpot() {
  setPrice("crypto:tether", 32);
  setPrice("crypto:bitcoin", 1_920_000);
  setPrice("crypto:ethereum", 100_000);
  const id = holding("crypto:bitcoin", 0.5, 2_000_000, { account: "Bybit 現貨", symbol: "BTC", name: "Bitcoin" });
  db().prepare("UPDATE accounts SET source = 'bybit' WHERE id = ?").run(id);
  return id;
}

describe("runSync", () => {
  it("does nothing without a key or a linked account", async () => {
    linkFutures();
    expect(await runSync("full", T0)).toEqual({ synced: false, error: null });
    vi.stubEnv("BYBIT_API_KEY", "key");
    vi.stubEnv("BYBIT_API_SECRET", "secret");
    db().prepare("DELETE FROM futures_accounts").run();
    expect(await runSync("full", T0)).toEqual({ synced: false, error: null });
  });

  it("reads the wallet, margin rate and positions, unpacking 1000-coin contracts", async () => {
    linkFutures();
    saveInstrument("crypto:pepe", "PEPE", "Pepe");
    const api = emptyApi();
    api.unified = [
      { coin: "USDT", walletBalance: "1000", spotBorrow: "0" },
      { coin: "BTC", walletBalance: "0.5" },
    ];
    api.fund = [{ coin: "USDT", walletBalance: "200" }];
    api.positions = [
      { symbol: "BTCUSDT", side: "Buy", size: "0.1", avgPrice: "60000", markPrice: "65000", liqPrice: "50000", leverage: "10", unrealisedPnl: "500" },
      { symbol: "1000PEPEUSDT", side: "Sell", size: "2000", avgPrice: "0.012", markPrice: "0.011", liqPrice: "", leverage: "5", unrealisedPnl: "2" },
      { symbol: "ETHUSDT", side: "", size: "0", avgPrice: "0", markPrice: "3000", liqPrice: "", leverage: "10", unrealisedPnl: "0" },
    ];
    const { headers } = bybitApi(api);

    expect(await runSync("balances", T0)).toEqual({ synced: true, error: null });
    expect(futuresAccount()).toMatchObject({ wallet_balance: 1200, fund_balance: 200, margin_rate: 12.34, synced_at: T0.toISOString(), sync_error: null });
    expect(positions()).toMatchObject([
      { coin_id: "bitcoin", symbol: "BTC", side: "long", quantity: 0.1, entry_price: 60000, mark_price: 65000, liq_price: 50000, leverage: 10, upnl: 500, note: null },
      { coin_id: "pepe", symbol: "PEPE", side: "short", quantity: 2_000_000, liq_price: null, upnl: 2, note: "1000PEPEUSDT" },
    ]);
    expect(positions()[1].entry_price).toBeCloseTo(0.000012, 12);
    expect(futuresLedger()).toBeUndefined(); // the ledger account starts with the first full sync
    expect(headers[0]).toMatchObject({ "X-BAPI-API-KEY": "key", "X-BAPI-RECV-WINDOW": "10000" });
    expect(getRuns().get("sync:bybit")).toMatchObject({ failing: 0 });
  });

  it("opens the futures ledger at the first full sync, then writes what the log adds after it", async () => {
    linkFutures();
    const api = emptyApi();
    api.unified = [{ coin: "USDT", walletBalance: "1000" }];
    api.fund = [{ coin: "USDT", walletBalance: "200" }];
    // From before the account was linked: never read.
    api.log = [log({ id: "old", transactionTime: inMin(T0, -5), cashFlow: "999", change: "999" })];
    bybitApi(api);

    await runSync("full", T0);
    const ledger = futuresLedger()!;
    expect(ledger).toMatchObject({ name: "Bybit UTA", currency: "USDT", source: "bybit" });
    expect(futuresAccount().account_id).toBe(ledger.id);
    expect(txs(ledger.id)).toMatchObject([{ type: "open", amount: 1200 }]);

    api.log.push(
      log({ id: "a", cashFlow: "-50", fee: "1", change: "-51" }),
      log({ id: "b", type: "SETTLEMENT", change: "-2" }),
      log({ id: "c", type: "TRANSFER_IN", change: "100" }),
    );
    api.deposits = [{ id: "d1", txID: "0x1", coin: "USDT", chain: "TRX", amount: "100", status: 3, successAt: inMin(T0, 2) }];
    api.withdrawals = [{ withdrawId: "w1", coin: "USDT", chain: "TRX", amount: "40", withdrawFee: "1", status: "success", createTime: inMin(T0, 3), updateTime: inMin(T0, 4), withdrawType: 0 }];
    api.unified = [{ coin: "USDT", walletBalance: "1006" }];
    await runSync("full", T1);
    expect(txs(ledger.id).map((t) => [t.type, t.amount])).toEqual([
      ["open", 1200],
      ["pnl", -51],
      ["funding", -2],
      ["deposit", 100],
      ["withdraw", -41],
    ]);
    expect(seriesAt(ledger.id, null, "2026-10-27").quantity).toBe(1206);
    expect(inbox()).toEqual([]); // matches the wallet

    // Read again with an overlap: nothing twice.
    await runSync("full", T2);
    expect(txs(ledger.id)).toHaveLength(5);
  });

  it("reports a wallet that the log doesn't explain", async () => {
    linkFutures();
    const api = emptyApi();
    api.unified = [{ coin: "USDT", walletBalance: "1000" }];
    bybitApi(api);
    await runSync("full", T0);
    api.unified = [{ coin: "USDT", walletBalance: "1300" }]; // e.g. bought with P2P
    await runSync("full", T1);
    expect(openItems(T2)).toMatchObject([{ kind: "diff", amount: 300, title: "餘額：Bybit 1,300 USDT，帳本 1,000" }]);
  });

  it("counts USDC as margin: in the wallet, its log and its deposits, never as spot", async () => {
    linkFutures();
    const spot = linkSpot();
    const api = emptyApi();
    api.unified = [
      { coin: "USDT", walletBalance: "800" },
      { coin: "USDC", walletBalance: "2500" },
      { coin: "BTC", walletBalance: "0.5" },
    ];
    api.fund = [{ coin: "USDC", walletBalance: "100" }];
    bybitApi(api);
    await runSync("full", T0);
    expect(futuresAccount()).toMatchObject({ wallet_balance: 3400, fund_balance: 100 });
    const ledger = futuresLedger()!;
    expect(txs(ledger.id)).toMatchObject([{ type: "open", amount: 3400, note: "開始同步時的保證金餘額（USDT＋USDC）" }]);

    api.log = [log({ id: "u1", currency: "USDC", symbol: "BTCPERP", cashFlow: "20", change: "20" })];
    api.deposits = [{ id: "d3", txID: "0x3", coin: "USDC", chain: "ETH", amount: "50", status: 3, successAt: inMin(T0, 2) }];
    api.unified[1] = { coin: "USDC", walletBalance: "2570" };
    await runSync("full", T1);
    expect(txs(ledger.id).map((t) => [t.type, t.amount])).toEqual([
      ["open", 3400],
      ["pnl", 20],
      ["deposit", 50],
    ]);
    expect(futuresAccount().wallet_balance).toBe(3470);
    // Nothing to confirm: the wallet adds up, and USDC is no spot holding.
    expect(inbox()).toEqual([]);
    expect(seriesAt(spot, "crypto:usd-coin", "2026-10-27").quantity).toBe(0);
  });

  it("applies spot fills, queues coin deposits to confirm, and checks every coin against the ledger", async () => {
    linkFutures();
    const spot = linkSpot();
    const api = emptyApi();
    api.unified = [
      { coin: "USDT", walletBalance: "500" },
      { coin: "BTC", walletBalance: "0.5" },
    ];
    // Before the spot account was linked: never read.
    api.fills = [fill({ execId: "old", execTime: inMin(T0, -5) })];
    bybitApi(api);
    await runSync("full", T0);
    expect(txs(spot)).toHaveLength(1);

    api.fills.push(fill({}), fill({ execId: "e2", side: "Sell", execQty: "1", execValue: "60000", execFee: "6", feeCurrency: "USDT", execTime: inMin(T0, 2) }));
    // A deposit not confirmed yet, then the sell it paid for.
    api.deposits = [{ id: "d2", txID: "0x2", coin: "BTC", chain: "BTC", amount: "1", status: 3, successAt: inMin(T0, 1.5) }];
    api.internal = [{ id: "i1", coin: "ETH", amount: "2", status: 2, createdTime: inMin(T0, 3) }];
    api.unified = [
      { coin: "USDT", walletBalance: "500" },
      { coin: "BTC", walletBalance: "0.5999" },
      { coin: "ETH", walletBalance: "2" },
    ];
    await runSync("full", T1);

    expect(txs(spot).map((t) => [t.type, t.source, t.external_id])).toEqual([
      ["open", "manual", null],
      ["buy", "bybit", "bybit:fill:e1"],
    ]);
    expect(seriesAt(spot, "crypto:bitcoin", "2026-10-27").quantity).toBeCloseTo(0.5999, 10);
    // The sell needs the BTC of the deposit nobody has confirmed: it waits, and is retried each sync.
    expect(inbox()).toMatchObject([
      { kind: "record", key: "bybit:fill:e2", auto: 1, error: expect.any(String) },
      { kind: "record", key: "bybit:deposit:d2", asset: "crypto:bitcoin", quantity: 1, price: 1_920_000, title: "收到 1 BTC", detail: "鏈上入金（BTC）" },
      { kind: "record", key: "bybit:internal:i1", asset: "crypto:ethereum", type: "deposit", quantity: 2, price: 100_000, title: "收到 2 ETH" },
    ]);
    expect(bybitStatus()).toMatchObject({ configured: true, pendingFills: 1, spot: { id: spot } });
    // What is waiting explains the balances: no differences.
    expect(openItems(T2).filter((i) => i.kind === "diff")).toEqual([]);

    acceptItem(inbox()[1].id, { type: "deposit", date: "2026-10-27", quantity: 1, price: 1_920_000, amount: 0, note: null }, T1);
    await runSync("full", T2);
    expect(inbox().map((i) => i.key)).toEqual(["bybit:internal:i1"]);
    expect(txs(spot).map((t) => t.type)).toEqual(["open", "buy", "deposit", "sell"]);
    expect(seriesAt(spot, "crypto:bitcoin", "2026-10-27").quantity).toBeCloseTo(0.5999, 10);
  });

  it("explains an API error on the account and in the job log", async () => {
    linkFutures();
    bybitApi(emptyApi(), { retCode: 10010, retMsg: "Unmatched IP" });
    const r = await runSync("balances", T0);
    expect(r).toEqual({ synced: false, error: "Bybit API：10010 Unmatched IP（這個 IP 不在 API key 的白名單）" });
    expect(futuresAccount().sync_error).toBe(r.error);
    expect(getRuns().get("sync:bybit")).toMatchObject({ failing: 1, last_error: r.error });
  });

  it("names the region block behind a 403", async () => {
    linkFutures();
    bybitApi(emptyApi(), { status: 403 });
    expect((await runSync("balances", T0)).error).toMatch(/不接受美國、中國大陸的 IP/);
  });
});

describe("syncBybit", () => {
  it("shares a sync that is already waiting to start", async () => {
    const a = syncBybit("full");
    const b = syncBybit("full");
    expect(b).toBe(a);
    expect(await a).toEqual({ synced: false, error: null });
  });
});
