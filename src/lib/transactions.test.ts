import { beforeEach, describe, expect, it } from "vitest";
import { cashAccount, holding, resetDb, tx } from "@/test/helpers";
import { db } from "./db";
import { compareWithLedger, legacyHoldings } from "./legacy";
import { getAccount, ledgerHoldings, listTransactions } from "./ledger";
import {
  accountByName,
  addTransaction,
  deleteAccount,
  deleteTransaction,
  LedgerError,
  saveCashAccount,
  transferAsset,
  updateAccount,
  updateTransaction,
} from "./transactions";

beforeEach(resetDb);

const rows = (table: string) => db().prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];

describe("addTransaction", () => {
  it("updates the old tables incrementally, the way the old forms did", () => {
    const a = holding("tw:2330", 1_000, 100);
    addTransaction({ ...tx("buy", a, "tw:2330", 1_000, 120, "2026-02-01"), fee: 171, amount: -120_171 });
    expect(rows("stock_holdings")).toMatchObject([{ symbol: "2330", shares: 2_000, avg_cost: 110.0855, broker: "國泰", account_id: a }]);
    addTransaction(tx("sell", a, "tw:2330", -2_000, 130, "2026-03-01"));
    expect(rows("stock_holdings")).toEqual([]);
    expect(compareWithLedger()).toEqual([]);
  });

  it("re-derives the old row when an entry is back-dated", () => {
    const a = holding("tw:2330", 1_000, 100, { date: "2026-01-02" });
    addTransaction(tx("sell", a, "tw:2330", -500, 120, "2026-03-01"));
    addTransaction(tx("buy", a, "tw:2330", 1_000, 130, "2026-02-01"));
    expect(compareWithLedger()).toEqual([]);
    expect(rows("stock_holdings")[0]).toMatchObject({ shares: 1_500, avg_cost: 115 });
  });

  it("ignores a repeated (source, external_id), so a sync can be re-run", () => {
    const a = holding("crypto:bitcoin", 1, 100);
    const synced = { ...tx("buy", a, "crypto:bitcoin", 1, 200, "2026-02-01"), source: "bybit", externalId: "fill-1" };
    expect(addTransaction(synced)).toEqual(expect.any(Number));
    expect(addTransaction(synced)).toBeNull();
    expect(ledgerHoldings("crypto")[0].quantity).toBe(2);
    expect(rows("crypto_holdings")[0]).toMatchObject({ amount: 2 });
  });

  it("refuses what the account can't hold, overselling and future dates", () => {
    const cash = cashAccount("薪轉", 1);
    const a = holding("tw:2330", 10, 100);
    expect(() => addTransaction(tx("buy", cash, "tw:2330", 1, 1))).toThrow("這個帳戶不能記這種交易");
    expect(() => addTransaction(tx("sell", a, "tw:2330", -11, 1, "2026-02-01"))).toThrow(LedgerError);
    expect(() => addTransaction(tx("buy", a, "tw:2330", 1, 1, "2999-01-01"))).toThrow("日期不能晚於今天");
    expect(() => addTransaction({ ...tx("buy", a, "tw:2330", 1, 1), date: "2026/01/01" })).toThrow("日期格式");
    expect(() => addTransaction({ ...tx("buy", a, "tw:2330", 1, 1), accountId: 999 })).toThrow("找不到這個帳戶");
  });
});

describe("updateTransaction / deleteTransaction", () => {
  it("re-derives both series when an entry moves to another account", () => {
    const a = holding("tw:2330", 1_000, 100, { account: "國泰" });
    const b = accountByName("stock", "永豐").id;
    const id = addTransaction(tx("buy", a, "tw:2330", 500, 110, "2026-02-01"))!;
    updateTransaction(id, tx("buy", b, "tw:2330", 500, 110, "2026-02-01"));
    expect(legacyHoldings("stock").map((h) => [h.account, h.quantity])).toEqual([
      ["國泰", 1_000],
      ["永豐", 500],
    ]);
    expect(compareWithLedger()).toEqual([]);
  });

  it("refuses an edit or delete that would leave a later sell short", () => {
    const a = holding("tw:2330", 1_000, 100);
    const buy = addTransaction(tx("buy", a, "tw:2330", 1_000, 100, "2026-02-01"))!;
    addTransaction(tx("sell", a, "tw:2330", -1_500, 110, "2026-03-01"));
    expect(() => deleteTransaction(buy)).toThrow("數量會變成負數");
    expect(() => updateTransaction(buy, tx("buy", a, "tw:2330", 100, 100, "2026-02-01"))).toThrow(LedgerError);
    updateTransaction(buy, tx("buy", a, "tw:2330", 500, 100, "2026-02-01"));
    expect(ledgerHoldings("stock")).toEqual([]);
    expect(compareWithLedger()).toEqual([]);
  });

  it("leaves synced transactions alone, and won't move one to another kind of account", () => {
    const a = holding("crypto:bitcoin", 1, 100);
    const synced = addTransaction({ ...tx("buy", a, "crypto:bitcoin", 1, 1, "2026-02-01"), source: "bybit", externalId: "x" })!;
    expect(() => deleteTransaction(synced)).toThrow("同步進來的交易不能修改");
    const manual = addTransaction(tx("buy", a, "crypto:bitcoin", 1, 1, "2026-02-01"))!;
    const s = holding("tw:2330", 1, 1);
    expect(() => updateTransaction(manual, tx("buy", s, "tw:2330", 1, 1))).toThrow("不能把交易移到不同類型的帳戶");
    expect(() => deleteTransaction(12345)).toThrow("找不到這筆交易");
  });
});

describe("transferAsset", () => {
  it("moves units between your own accounts at the sender's average cost, once per source id", () => {
    const from = holding("crypto:bitcoin", 2, 1_000_000, { account: "冷錢包" });
    const to = holding("crypto:bitcoin", 1, 3_000_000, { account: "Bybit" });
    const move = () => transferAsset({ fromId: from, toId: to, asset: "crypto:bitcoin", quantity: 0.5, date: "2026-03-01", note: null, source: "bybit", externalId: "bybit:deposit:1" });
    expect(move()).toEqual(expect.any(Number));
    expect(move()).toBeNull();
    const held = Object.fromEntries(ledgerHoldings("crypto").map((h) => [h.account, [h.quantity, h.cost]]));
    expect(held).toEqual({ 冷錢包: [1.5, 1_500_000], Bybit: [1.5, 3_500_000] });
    expect(listTransactions({ accountId: from })[0]).toMatchObject({ type: "transfer", quantity: -0.5, note: "轉到 Bybit" });
    expect(compareWithLedger()).toEqual([]);
  });

  it("refuses moves the ledger can't follow", () => {
    const a = holding("crypto:bitcoin", 1, 1, { account: "冷錢包" });
    const b = holding("crypto:bitcoin", 1, 1, { account: "Bybit" });
    const s = holding("tw:2330", 1, 1);
    const move = (fromId: number, toId: number, quantity = 1) => () =>
      transferAsset({ fromId, toId, asset: "crypto:bitcoin", quantity, date: "2026-03-01", note: null });
    expect(move(a, a)).toThrow("不能是同一個帳戶");
    expect(move(a, s)).toThrow("同類型");
    expect(move(a, b, 0)).toThrow("必須大於 0");
    expect(move(a, b, 5)).toThrow(LedgerError);
    expect(ledgerHoldings("crypto").map((h) => h.quantity)).toEqual([1, 1]);
  });
});

describe("accounts", () => {
  it("renames the old tables' labels with the account, and refuses a duplicate name", () => {
    const a = holding("tw:2330", 1, 1, { account: "國泰" });
    holding("tw:2330", 1, 1, { account: "永豐" });
    updateAccount(a, { name: "國泰證券", institution: "國泰", feeDiscount: 0.28, note: null });
    expect(getAccount(a)).toMatchObject({ name: "國泰證券", fee_discount: 0.28 });
    expect(rows("stock_holdings")[0]).toMatchObject({ broker: "國泰證券" });
    expect(() => updateAccount(a, { name: "永豐", institution: null, feeDiscount: null, note: null })).toThrow("已經有叫「永豐」的帳戶");
    expect(compareWithLedger()).toEqual([]);
  });

  it("deletes an account with its transactions and old rows", () => {
    const a = holding("crypto:bitcoin", 1, 1);
    deleteAccount(a);
    expect([rows("accounts"), rows("transactions"), rows("crypto_holdings")]).toEqual([[], [], []]);
  });

  it("unlinks a futures wallet from the ledger account it deletes", () => {
    const id = Number(
      db().prepare("INSERT INTO accounts (kind, name, currency, source, created_at, updated_at) VALUES ('futures', 'UTA', 'USDT', 'bybit', '', '')").run()
        .lastInsertRowid,
    );
    db().prepare("INSERT INTO futures_accounts (name, source, account_id) VALUES ('UTA', 'bybit', ?)").run(id);
    deleteAccount(id);
    expect(rows("futures_accounts")).toMatchObject([{ account_id: null }]);
  });

  it("logs a cash balance change as today's adjustment, and keeps the old row set to what was typed", () => {
    const now = new Date("2026-10-26T04:00:00Z");
    saveCashAccount({ id: null, name: "薪轉", institution: "國泰", currency: "TWD", balance: 100, note: null }, now);
    const id = rows("accounts")[0].id as number;
    saveCashAccount({ id, name: "薪轉", institution: "國泰", currency: "TWD", balance: 80, note: "x" }, now);
    expect(listTransactions({ accountId: id }).map((t) => [t.date, t.type, t.amount])).toEqual([
      ["2026-10-26", "adjust", -20],
      ["2026-10-26", "open", 100],
    ]);
    expect(rows("cash_accounts")).toMatchObject([{ balance: 80, note: "x", account_id: id }]);
    expect(() => saveCashAccount({ id: holding("tw:2330", 1, 1), name: "x", institution: null, currency: "TWD", balance: 1, note: null })).toThrow(
      "不是現金帳戶",
    );
  });
});

describe("the old tables and the ledger agree", () => {
  // A deterministic pseudo-random sequence of trades, appended in date order like real entries.
  function* lcg(seed: number) {
    for (;;) yield (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  }

  it.each([1, 2, 3, 4, 5])("after a random run of trades (seed %i)", (seed) => {
    const rnd = lcg(seed);
    const r = () => rnd.next().value as number;
    const accounts = [holding("tw:2330", 1_000, 500, { account: "國泰" }), accountByName("stock", "永豐").id];
    const coins = [holding("crypto:bitcoin", 0.5, null, { account: "冷錢包" }), accountByName("crypto", "Bybit").id];
    const held = new Map<string, number>();
    for (const h of [...ledgerHoldings("stock"), ...ledgerHoldings("crypto")]) held.set(`${h.accountId}|${h.asset}`, h.quantity);

    for (let day = 0; day < 60; day++) {
      const date = `2026-0${3 + Math.floor(day / 28)}-${String((day % 28) + 1).padStart(2, "0")}`;
      const isCoin = r() < 0.4;
      const account = (isCoin ? coins : accounts)[Math.floor(r() * 2)];
      const asset = isCoin ? (r() < 0.5 ? "crypto:bitcoin" : "crypto:ethereum") : r() < 0.5 ? "tw:2330" : "tw:0050";
      const key = `${account}|${asset}`;
      const have = held.get(key) ?? 0;
      const price = Math.round(r() * 1_000) + 1;
      const roll = r();
      let input;
      if (roll < 0.45 || have <= 0) {
        const q = isCoin ? Math.round(r() * 1e6) / 1e6 + 0.001 : Math.ceil(r() * 3) * 1_000;
        input = { ...tx("buy", account, asset, q, price, date), fee: Math.round(r() * 50) };
      } else if (roll < 0.75) {
        const q = roll < 0.6 ? have : Math.round(have * r() * 1e6) / 1e6;
        if (q <= 0) continue;
        input = { ...tx("sell", account, asset, -q, price, date), fee: 3, tax: 7 };
      } else if (roll < 0.85) {
        input = { ...tx("dividend", account, asset, isCoin ? 0 : 100), amount: 500, date };
      } else {
        const q = Math.round((r() - 0.5) * have * 1e6) / 1e6;
        if (!q) continue;
        input = { ...tx("adjust", account, asset, q), date };
      }
      addTransaction(input);
      held.set(key, have + input.quantity);
    }

    expect(compareWithLedger()).toEqual([]);
  });

  it("reports what differs when the old table is changed behind the ledger's back", () => {
    const a = holding("tw:2330", 1_000, 100);
    holding("crypto:bitcoin", 1, null);
    const cash = cashAccount("薪轉", 100);
    db().prepare("UPDATE stock_holdings SET shares = 900").run();
    db().prepare("UPDATE crypto_holdings SET avg_cost_twd = 5").run();
    db().prepare("UPDATE cash_accounts SET balance = 99").run();
    db().prepare("INSERT INTO stock_holdings (symbol, shares) VALUES ('0050', 3)").run();
    db().prepare("INSERT INTO cash_accounts (name, balance) VALUES ('孤兒', 1)").run();
    addTransaction(tx("buy", a, "tw:00878", 1, 20, "2026-02-01"));
    db().prepare("DELETE FROM stock_holdings WHERE symbol = '00878'").run();

    expect(compareWithLedger()).toEqual([
      { label: "2330（國泰）", legacy: "900，成本 90,000", ledger: "1,000，成本 100,000" },
      { label: "0050（未指定）", legacy: "3", ledger: "沒有對應的帳本帳戶" },
      { label: "00878（國泰）", legacy: "沒有這筆", ledger: "1，成本 20" },
      { label: "BITCOIN（冷錢包）", legacy: "1，成本 5", ledger: "1，成本未知" },
      { label: "薪轉", legacy: "99", ledger: "100" },
      { label: "孤兒", legacy: "1", ledger: "沒有對應的帳本帳戶" },
    ]);
    expect(cash).toBeGreaterThan(0);
  });
});
