import { beforeEach, describe, expect, it } from "vitest";
import { cashAccount, holding, resetDb, tx } from "@/test/helpers";
import type { Transaction, TxType } from "./db";
import { ledgerCash, ledgerHoldings, ledgerIncome, listTransactions, replay } from "./ledger";
import { accountByName, addTransaction } from "./transactions";

let nextId = 1;
const t = (type: TxType, date: string, quantity: number, fields: Partial<Transaction> = {}): Transaction => ({
  id: nextId++,
  account_id: 1,
  date,
  type,
  asset: "tw:2330",
  quantity,
  price: null,
  amount: 0,
  fee: 0,
  tax: 0,
  source: "manual",
  external_id: null,
  note: null,
  created_at: "",
  updated_at: "",
  ...fields,
});

describe("replay", () => {
  it("keeps a moving-average cost that includes buy fees, and realizes PnL net of sell costs", () => {
    const s = replay([
      t("buy", "2026-01-02", 1_000, { price: 100, fee: 142, amount: -100_142 }),
      t("buy", "2026-02-02", 1_000, { price: 120, fee: 171, amount: -120_171 }),
      t("sell", "2026-03-02", -500, { price: 130, fee: 92, tax: 195, amount: 65_000 - 92 - 195 }),
    ]);
    expect(s.quantity).toBe(1_500);
    // Cost of 2,000 shares was 220,313; selling a quarter takes 55,078.25 of it.
    expect(s.cost).toBeCloseTo(220_313 * 0.75, 6);
    expect(s.realized).toEqual([{ date: "2026-03-02", amount: expect.closeTo(64_713 - 55_078.25, 6) }]);
  });

  it("replays by trade date, not entry order", () => {
    const sell = t("sell", "2026-03-01", -1_000, { price: 110, amount: 110_000 });
    const buy = t("buy", "2026-01-01", 1_000, { price: 100, amount: -100_000 });
    const s = replay([sell, buy]);
    expect(s).toMatchObject({ quantity: 0, cost: 0, negativeAt: null });
    expect(s.realized[0].amount).toBeCloseTo(10_000, 6);
  });

  it("adds stock dividends and adjustments at no cost, diluting the average", () => {
    const s = replay([
      t("open", "2026-01-01", 1_000, { price: 50 }),
      t("dividend", "2026-07-01", 100, { amount: 2_000 }),
      t("adjust", "2026-08-01", 900),
    ]);
    expect(s).toMatchObject({ quantity: 2_000, cost: 50_000 });
    expect(s.dividends).toEqual([{ date: "2026-07-01", amount: 2_000 }]);
  });

  it("takes cost out proportionally when an adjustment removes units, without realizing anything", () => {
    const s = replay([t("open", "2026-01-01", 1_000, { price: 50 }), t("adjust", "2026-02-01", -400)]);
    expect(s).toMatchObject({ quantity: 600, cost: 30_000, realized: [] });
  });

  it("treats units of unknown cost as unknown until the position closes", () => {
    const s = replay([
      t("open", "2026-01-01", 1_000, { price: null }),
      t("buy", "2026-02-01", 1_000, { price: 100, amount: -100_000 }),
      t("sell", "2026-03-01", -500, { price: 100, amount: 50_000 }),
    ]);
    expect(s).toMatchObject({ quantity: 1_500, cost: null, realized: [] });

    const reopened = replay([
      t("adjust", "2026-01-01", 5),
      t("sell", "2026-02-01", -5, { price: 10, amount: 50 }),
      t("buy", "2026-03-01", 2, { price: 20, fee: 1, amount: -41 }),
    ]);
    expect(reopened).toMatchObject({ quantity: 2, cost: 41 });
  });

  it("flags the transaction that takes a series below zero, and snaps dust to zero", () => {
    const over = t("sell", "2026-02-01", -2, { price: 1, amount: 2 });
    expect(replay([t("buy", "2026-01-01", 1, { price: 1, amount: -1 }), over]).negativeAt).toBe(over);
    const coins = replay([t("buy", "2026-01-01", 0.3, { price: 1 }), t("buy", "2026-01-02", 0.6, { price: 1 }), t("sell", "2026-01-03", -0.9, { price: 1 })]);
    expect(coins).toMatchObject({ quantity: 0, cost: 0, negativeAt: null });
  });
});

describe("ledger reads", () => {
  beforeEach(resetDb);

  it("lists open positions with their account and instrument names", () => {
    holding("tw:2330", 1_000, 500, { account: "國泰", name: "台積電" });
    const closed = holding("tw:0050", 100, 100, { account: "國泰" });
    addTransaction(tx("sell", closed, "tw:0050", -100, 110, "2026-02-01"));
    holding("crypto:bitcoin", 0.5, null, { symbol: "BTC" });

    expect(ledgerHoldings("stock")).toEqual([
      { accountId: expect.any(Number), account: "國泰", asset: "tw:2330", symbol: "2330", name: "台積電", quantity: 1_000, cost: 500_000 },
    ]);
    expect(ledgerHoldings("crypto")).toMatchObject([{ account: "冷錢包", asset: "crypto:bitcoin", symbol: "BTC", quantity: 0.5, cost: null }]);
    expect(ledgerIncome("stock", "2026")).toEqual({ realized: 1_000, dividends: 0 });
    expect(ledgerIncome("stock", "2025")).toEqual({ realized: 0, dividends: 0 });
  });

  it("sums each cash account's transactions into its balance", () => {
    const id = cashAccount("薪轉", 100);
    addTransaction(tx("adjust", id, null, 0));
    addTransaction({ ...tx("adjust", id, null, 0), amount: -30 });
    expect(ledgerCash()).toEqual([{ accountId: id, name: "薪轉", institution: null, currency: "TWD", balance: 70, note: null }]);
  });

  it("filters the transaction list, newest first", () => {
    const a = holding("tw:2330", 1_000, 500, { date: "2026-01-02" });
    addTransaction(tx("buy", a, "tw:2330", 10, 600, "2026-03-01"));
    holding("crypto:bitcoin", 1, 1);
    expect(listTransactions().map((r) => [r.type, r.asset])).toEqual([
      ["buy", "tw:2330"],
      ["open", "crypto:bitcoin"],
      ["open", "tw:2330"],
    ]);
    expect(listTransactions({ kind: "crypto" })).toHaveLength(1);
    expect(listTransactions({ accountId: a, type: "buy" })).toMatchObject([{ account_name: "國泰", account_kind: "stock", symbol: "2330" }]);
    expect(listTransactions({ asset: "tw:2330", limit: 1 })).toHaveLength(1);
    expect(accountByName("stock", "國泰").id).toBe(a);
  });
});
