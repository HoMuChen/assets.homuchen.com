import { beforeEach, describe, expect, it } from "vitest";
import { at, holding, resetDb, tx } from "@/test/helpers";
import { db, type InboxItem, type Transaction } from "./db";
import { acceptItem, acceptTypes, addRecord, clearSource, DIFF_SETTLE_MS, dismissItem, openCount, openItems, reportHolding, retryAuto } from "./inbox";
import { saveInstrument, seriesAt } from "./ledger";
import { accountByName, addTransaction, LedgerError } from "./transactions";

beforeEach(resetDb);

const NOW = at("2026-10-27 12:00");
const later = new Date(NOW.getTime() + DIFF_SETTLE_MS);
const rows = () => db().prepare("SELECT * FROM inbox ORDER BY id").all() as InboxItem[];
const txs = (accountId: number) => db().prepare("SELECT * FROM transactions WHERE account_id = ? ORDER BY id").all(accountId) as Transaction[];

/** The Bybit crypto account holding `btc` BTC at 2,000,000 TWD each. */
function bybit(btc: number) {
  return holding("crypto:bitcoin", btc, 2_000_000, { account: "Bybit", symbol: "BTC", name: "Bitcoin" });
}

const record = (accountId: number, fields: Partial<Parameters<typeof addRecord>[0]> = {}) =>
  addRecord(
    {
      key: "bybit:deposit:1",
      accountId,
      asset: "crypto:bitcoin",
      source: "bybit",
      date: "2026-10-26",
      type: "deposit",
      quantity: 0.5,
      price: 2_100_000,
      amount: 0,
      title: "收到 0.5 BTC",
      ...fields,
    },
    NOW,
  );

describe("reportHolding / openItems", () => {
  it("says nothing while the source and the ledger agree", () => {
    const id = bybit(1);
    reportHolding({ accountId: id, asset: "crypto:bitcoin", source: "bybit", date: "2026-10-27", observed: 1 }, NOW);
    expect(rows()).toEqual([]);
  });

  it("shows a sync's difference once it has lasted, and closes it when the ledger catches up", () => {
    const id = bybit(1);
    reportHolding({ accountId: id, asset: "crypto:bitcoin", source: "bybit", date: "2026-10-27", observed: 1.25 }, NOW);
    expect(openItems(NOW)).toEqual([]); // a fill may be on its way
    const [item] = openItems(later);
    expect(item).toMatchObject({ kind: "diff", symbol: "BTC", ledger: 1, quantity: 0.25, accountName: "Bybit", title: "BTC：Bybit 1.25，帳本 1" });

    addTransaction({ ...tx("buy", id, "crypto:bitcoin", 0.25, 2_000_000), date: "2026-10-27" });
    expect(openItems(later)).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("shows an import's difference straight away", () => {
    const id = holding("tw:2330", 1000, 600);
    reportHolding({ accountId: id, asset: "tw:2330", source: "import", date: "2026-10-27", observed: 1200, detail: "國泰 庫存對帳單" }, NOW);
    expect(openItems(NOW)).toMatchObject([{ quantity: 200, title: "2330：對帳單 1,200，帳本 1,000", detail: "國泰 庫存對帳單" }]);
    expect(openCount(NOW)).toBe(1);
  });

  it("counts records still waiting to be confirmed as explained", () => {
    const id = bybit(1);
    record(id);
    reportHolding({ accountId: id, asset: "crypto:bitcoin", source: "bybit", date: "2026-10-27", observed: 1.5 }, NOW);
    expect(rows().map((r) => r.kind)).toEqual(["record"]);
  });

  it("measures a cash-like account by its balance", () => {
    db().prepare("INSERT INTO accounts (kind, name, currency, source, created_at, updated_at) VALUES ('futures', 'UTA', 'USDT', 'bybit', '', '')").run();
    const id = (db().prepare("SELECT id FROM accounts WHERE kind = 'futures'").get() as { id: number }).id;
    addTransaction({ accountId: id, date: "2026-10-20", type: "open", asset: null, quantity: 0, price: null, amount: 1000, fee: 0, tax: 0, note: null });
    reportHolding({ accountId: id, asset: null, source: "bybit", date: "2026-10-27", observed: 1100 }, NOW);
    expect(openItems(later)).toMatchObject([{ amount: 100, quantity: 0, title: "餘額：Bybit 1,100 USDT，帳本 1,000" }]);
  });

  it("keeps a dismissed difference away until the source reports another number", () => {
    const id = bybit(1);
    const report = (observed: number) => reportHolding({ accountId: id, asset: "crypto:bitcoin", source: "bybit", date: "2026-10-27", observed }, NOW);
    report(2);
    dismissItem(rows()[0].id, NOW);
    report(2);
    expect(openItems(later)).toEqual([]);
    report(3);
    expect(openItems(later)).toMatchObject([{ quantity: 2 }]);
  });

  it("forgets what one source reported for an account", () => {
    const id = bybit(1);
    reportHolding({ accountId: id, asset: "crypto:bitcoin", source: "bybit", date: "2026-10-27", observed: 2 }, NOW);
    clearSource(id, "import");
    expect(rows()).toHaveLength(1);
    clearSource(id, "bybit");
    expect(rows()).toEqual([]);
  });
});

describe("addRecord", () => {
  it("adds a source record once, keeping a dismissed one dismissed", () => {
    const id = bybit(1);
    record(id);
    record(id, { error: "later" });
    expect(rows()).toMatchObject([{ kind: "record", quantity: 0.5, error: "later" }]);
    dismissItem(rows()[0].id, NOW);
    record(id);
    expect(rows()).toMatchObject([{ status: "dismissed" }]);
    expect(openItems(later)).toEqual([]);
  });

  it("doesn't bring back a record once it is confirmed, though the source lists it again", () => {
    const id = bybit(1);
    record(id);
    acceptItem(rows()[0].id, { type: "deposit", date: "2026-10-26", quantity: 0.5, price: 2_100_000, amount: 0, note: null }, NOW);
    record(id);
    expect(rows()).toEqual([]);
  });
});

describe("acceptItem", () => {
  it("records a coin deposit at the price given, under the record's id", () => {
    const id = bybit(1);
    record(id);
    acceptItem(rows()[0].id, { type: "deposit", date: "2026-10-26", quantity: 0.5, price: 2_100_000, amount: 0, note: "從冷錢包" }, NOW);
    expect(rows()).toEqual([]);
    expect(seriesAt(id, "crypto:bitcoin", "2026-10-27")).toEqual({ quantity: 1.5, cost: 3_050_000 });
    expect(txs(id).at(-1)).toMatchObject({ type: "deposit", source: "bybit", external_id: "bybit:deposit:1", note: "從冷錢包" });
    expect(() => acceptItem(1, { type: "deposit", date: "2026-10-26", quantity: 1, price: null, amount: 0, note: null }, NOW)).toThrow("這筆已經處理過了");
  });

  it("moves coins between your own accounts with their cost", () => {
    const cold = holding("crypto:bitcoin", 2, 1_000_000, { account: "冷錢包", symbol: "BTC" });
    const id = bybit(1);
    record(id);
    acceptItem(rows()[0].id, { type: "transfer", date: "2026-10-26", quantity: 0.5, price: null, amount: 0, note: null, counterpartId: cold }, NOW);
    expect(seriesAt(id, "crypto:bitcoin", "2026-10-27")).toEqual({ quantity: 1.5, cost: 2_500_000 });
    expect(seriesAt(cold, "crypto:bitcoin", "2026-10-27")).toEqual({ quantity: 1.5, cost: 1_500_000 });
    expect(() =>
      acceptItem(999, { type: "transfer", date: "2026-10-26", quantity: 1, price: null, amount: 0, note: null, counterpartId: cold }, NOW),
    ).toThrow(LedgerError);
  });

  it("sends a withdrawal out less its network fee, which stays behind as a fee", () => {
    const cold = holding("crypto:bitcoin", 0, 1_000_000, { account: "冷錢包", symbol: "BTC" });
    const id = bybit(1);
    record(id, { key: "bybit:withdraw:9", type: "withdraw", quantity: -0.3005, price: null, networkFee: 0.0005, title: "提出 0.3005 BTC" });
    acceptItem(rows()[0].id, { type: "transfer", date: "2026-10-26", quantity: -0.3005, price: null, amount: 0, note: null, counterpartId: cold }, NOW);
    expect(seriesAt(id, "crypto:bitcoin", "2026-10-27").quantity).toBeCloseTo(0.6995, 10);
    expect(seriesAt(cold, "crypto:bitcoin", "2026-10-27")).toEqual({ quantity: 0.3, cost: 600_000 });
    expect(txs(id).map((t) => t.type)).toEqual(["open", "transfer", "fee"]);
  });

  it("asks for what a transfer or an amount needs, and refuses types the account can't take", () => {
    const id = bybit(1);
    record(id);
    const item = rows()[0].id;
    const base = { date: "2026-10-26", price: null, amount: 0, note: null };
    expect(() => acceptItem(item, { ...base, type: "transfer", quantity: 0.5 }, NOW)).toThrow("請選擇對方帳戶");
    expect(() => acceptItem(item, { ...base, type: "buy", quantity: 0 }, NOW)).toThrow("數量不能是 0");
    expect(() => acceptItem(item, { ...base, type: "pnl", quantity: 0.5 }, NOW)).toThrow("這個帳戶不能記這種交易");
    expect(rows()).toHaveLength(1);
  });

  it("confirms a difference as your own adjustment", () => {
    const id = bybit(1);
    reportHolding({ accountId: id, asset: "crypto:bitcoin", source: "bybit", date: "2026-10-27", observed: 0.9 }, NOW);
    const [item] = openItems(later);
    acceptItem(item.id, { type: "adjust", date: "2026-10-27", quantity: item.quantity, price: null, amount: 0, note: null }, later);
    expect(seriesAt(id, "crypto:bitcoin", "2026-10-27").quantity).toBeCloseTo(0.9, 10);
    expect(txs(id).at(-1)).toMatchObject({ type: "adjust", source: "manual", external_id: null });
    expect(rows()).toEqual([]);
  });

  it("writes a cash-like account's change as an amount", () => {
    db().prepare("INSERT INTO accounts (kind, name, currency, source, created_at, updated_at) VALUES ('futures', 'UTA', 'USDT', 'bybit', '', '')").run();
    const id = (db().prepare("SELECT id FROM accounts WHERE kind = 'futures'").get() as { id: number }).id;
    reportHolding({ accountId: id, asset: null, source: "bybit", date: "2026-10-27", observed: 50 }, NOW);
    const [item] = openItems(later);
    expect(() => acceptItem(item.id, { type: "deposit", date: "2026-10-27", quantity: 0, price: null, amount: 0, note: null }, later)).toThrow("金額不能是 0");
    acceptItem(item.id, { type: "deposit", date: "2026-10-27", quantity: 0, price: null, amount: 50, note: "P2P" }, later);
    expect(seriesAt(id, null, "2026-10-27").quantity).toBe(50);
  });

  it("offers the types that fit the account", () => {
    expect(acceptTypes("futures")).toContain("pnl");
    expect(acceptTypes("cash")).not.toContain("buy");
    expect(acceptTypes("crypto")).toEqual(expect.arrayContaining(["buy", "transfer", "deposit"]));
  });
});

describe("retryAuto", () => {
  it("applies a fill the ledger couldn't take before, and keeps the reason while it still can't", () => {
    const id = accountByName("crypto", "Bybit").id;
    saveInstrument("crypto:ethereum", "ETH", "Ethereum");
    const sell = { ...tx("sell", id, "crypto:ethereum", -1, 100_000), date: "2026-10-26" };
    addRecord({ key: "bybit:fill:1", accountId: id, asset: sell.asset, source: "bybit", date: sell.date, type: "sell", quantity: -1, price: 100_000, amount: 100_000, title: "賣 ETH", auto: true }, NOW);

    expect(retryAuto(NOW)).toBe(0);
    expect(rows()[0].error).toMatch(/./);

    addTransaction({ ...tx("buy", id, "crypto:ethereum", 1, 90_000), date: "2026-10-25" });
    expect(retryAuto(NOW)).toBe(1);
    expect(rows()).toEqual([]);
    expect(txs(id).at(-1)).toMatchObject({ type: "sell", source: "bybit", external_id: "bybit:fill:1" });
  });
});
