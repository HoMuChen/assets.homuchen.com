import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch, mockTelegram, resetDb } from "@/test/helpers";
import {
  deleteItem,
  login,
  saveAccount,
  saveCash,
  saveFuturesPosition,
  saveProperty,
  saveTransaction,
  saveTwFutures,
  sendTestNotification,
  setLedgerMode,
  snapshotNow,
} from "./actions";
import { db } from "./db";
import { getRuns, recordRun } from "./jobs";
import { compareWithLedger } from "./legacy";
import { ledgerMode } from "./ledger";
import { setSetting } from "./settings";
import { SESSION_COOKIE } from "./session";

// Server Functions run outside a request here: stand in for the Next.js request APIs they touch.
const { jar } = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "vitest" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

beforeEach(() => {
  resetDb();
  jar.clear();
});

const form = (fields: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
};
const all = (table: string) => db().prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];

/** Quote and lookup endpoints the actions hit after saving. */
function mockMarketData() {
  return mockFetch([
    ["dataset=TaiwanStockInfo", () => Response.json({ status: 200, msg: "", data: [{ stock_id: "2330", stock_name: "台積電" }] })],
    ["taiwan_stock_tick_snapshot", () => Response.json({ status: 200, msg: "", data: [{ close: 1_000, change_rate: 0, date: "" }] })],
    [
      "/search?query=",
      () =>
        Response.json({
          coins: [
            { id: "batcat", symbol: "btc", name: "Batcat", market_cap_rank: 4_000 },
            { id: "bitcoin", symbol: "btc", name: "Bitcoin", market_cap_rank: 1 },
          ],
        }),
    ],
    ["/simple/price", () => Response.json({})],
    ["open.er-api.com", () => Response.json({ result: "success", rates: { USD: 1, TWD: 32 }, time_last_update_utc: "Mon, 26 Oct 2026 00:00:00 +0000" })],
  ]);
}

describe("auth", () => {
  it("refuses every Server Function without a session once a password is set", async () => {
    vi.stubEnv("APP_PASSWORD", "pw");
    await expect(saveCash(null, form({ name: "x", currency: "TWD", balance: 1 }))).rejects.toThrow("Unauthorized");
    await expect(deleteItem("account", 1)).rejects.toThrow("Unauthorized");
    expect(all("cash_accounts")).toEqual([]);
  });

  it("logs in with the right password and sets a session cookie", async () => {
    vi.stubEnv("APP_PASSWORD", "pw");
    await expect(login(null, form({ password: "pw" }))).rejects.toThrow("NEXT_REDIRECT /");
    expect(jar.get(SESSION_COOKIE)).toBeTruthy();
    mockMarketData();
    expect(await saveCash(null, form({ name: "薪轉", currency: "TWD", balance: 1 }))).toEqual({ ok: true });
  });

  it("rejects a wrong password", async () => {
    vi.stubEnv("APP_PASSWORD", "pw");
    expect(await login(null, form({ password: "nope" }))).toEqual({ ok: false, error: "密碼錯誤" });
    expect(jar.has(SESSION_COOKIE)).toBe(false);
  });
});

describe("saveCash", () => {
  it("accepts thousands separators and normalises the currency code", async () => {
    mockMarketData();
    expect(await saveCash(null, form({ name: "美元戶", currency: "usd", balance: "1,234.5" }))).toEqual({ ok: true });
    expect(all("accounts")[0]).toMatchObject({ kind: "cash", name: "美元戶", currency: "USD" });
    expect(all("cash_accounts")[0]).toMatchObject({ currency: "USD", balance: 1234.5, institution: null });
  });

  it("logs a changed balance as an adjustment, and reports the field that failed validation", async () => {
    mockMarketData();
    await saveCash(null, form({ name: "薪轉", currency: "TWD", balance: 1 }));
    const id = all("accounts")[0].id as number;
    await saveCash(null, form({ id, name: "薪轉戶", currency: "TWD", balance: 2.5 }));
    await saveCash(null, form({ id, name: "薪轉戶", currency: "TWD", balance: 2.5 }));
    expect(all("cash_accounts")).toMatchObject([{ name: "薪轉戶", balance: 2.5 }]);
    expect(all("transactions").map((t) => [t.type, t.amount])).toEqual([
      ["open", 1],
      ["adjust", 1.5],
    ]);
    expect(compareWithLedger()).toEqual([]);
    expect(await saveCash(null, form({ name: "x", currency: "US", balance: 1 }))).toEqual({
      ok: false,
      error: "幣別：三碼幣別，如 TWD / USD",
    });
    expect(await saveCash(null, form({ name: "x", currency: "TWD", balance: "abc" }))).toMatchObject({ ok: false, error: "餘額：請輸入數字" });
  });
});

describe("saveTransaction", () => {
  const stock = (fields: Record<string, string | number>) =>
    saveTransaction(null, form({ kind: "stock", account: "國泰", type: "buy", symbol: "2330", date: "2026-10-01", ...fields }));

  it("records a buy with the broker's commission, creating the account and looking up the name", async () => {
    mockMarketData();
    expect(await stock({ quantity: "1,000", price: 1_000 })).toEqual({ ok: true });
    expect(all("accounts")).toMatchObject([{ kind: "stock", name: "國泰" }]);
    expect(all("transactions")[0]).toMatchObject({ type: "buy", asset: "tw:2330", quantity: 1_000, fee: 1_425, tax: 0, amount: -1_001_425 });
    expect(all("instruments")).toEqual([{ asset: "tw:2330", symbol: "2330", name: "台積電" }]);
    expect(all("stock_holdings")[0]).toMatchObject({ symbol: "2330", name: "台積電", shares: 1_000, avg_cost: 1_001.425, broker: "國泰" });
  });

  it("applies the account's discount, and a sell pays transaction tax", async () => {
    mockMarketData();
    await stock({ quantity: 1_000, price: 1_000 });
    const id = all("accounts")[0].id as number;
    expect(await saveAccount(null, form({ id, name: "國泰", fee_discount: "2.8" }))).toEqual({ ok: true });
    expect(all("accounts")[0].fee_discount).toBeCloseTo(0.28, 10);
    expect(await stock({ type: "sell", quantity: 500, price: 1_100, date: "2026-10-02" })).toEqual({ ok: true });
    // 550,000 × 0.1425% × 0.28 = 219.45 → 219; × 0.3% = 1,650
    expect(all("transactions")[1]).toMatchObject({ quantity: -500, fee: 219, tax: 1_650, amount: 550_000 - 219 - 1_650 });
    expect(all("stock_holdings")[0]).toMatchObject({ shares: 500 });
    expect(compareWithLedger()).toEqual([]);
  });

  it("takes typed fees over the defaults, and records dividends", async () => {
    mockMarketData();
    await stock({ quantity: 1_000, price: 100, fee: 20 });
    expect(all("transactions")[0]).toMatchObject({ fee: 20, amount: -100_020 });
    expect(await stock({ type: "dividend", gross: "25,000", fee: 10, tax: 527, quantity: 50 })).toEqual({ ok: true });
    expect(all("transactions")[1]).toMatchObject({ type: "dividend", quantity: 50, price: null, amount: 25_000 - 10 - 527, fee: 10, tax: 527 });
    expect(await stock({ type: "dividend" })).toEqual({ ok: false, error: "現金股利：現金股利或配股至少填一項" });
  });

  it("refuses overselling, future dates, new opening balances and bad symbols", async () => {
    mockMarketData();
    await stock({ quantity: 1_000, price: 100 });
    expect(await stock({ type: "sell", quantity: 2_000, price: 100 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("數量會變成負數"),
    });
    expect(await stock({ quantity: 1, price: 1, date: "2999-01-01" })).toEqual({ ok: false, error: "日期不能晚於今天" });
    expect(await stock({ type: "open", quantity: 1, price: 1 })).toEqual({ ok: false, error: "期初只能修改，不能新增" });
    expect(await stock({ symbol: "AB", quantity: 1, price: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/^代號：/) });
    expect(await stock({ quantity: 0, price: 1 })).toEqual({ ok: false, error: "數量：必須大於 0" });
    expect(all("transactions")).toHaveLength(1);
  });

  it("edits a transaction and re-derives the old table", async () => {
    mockMarketData();
    await stock({ quantity: 1_000, price: 100, fee: 0 });
    const id = all("transactions")[0].id as number;
    expect(await stock({ id, quantity: 2_000, price: 100, fee: 0 })).toEqual({ ok: true });
    expect(all("transactions")).toHaveLength(1);
    expect(all("stock_holdings")[0]).toMatchObject({ shares: 2_000, avg_cost: 100 });
  });

  it("resolves a coin ticker to the CoinGecko coin with the highest market cap", async () => {
    mockMarketData();
    expect(
      await saveTransaction(null, form({ kind: "crypto", account: "冷錢包", type: "buy", symbol: "BTC", date: "2026-10-01", quantity: "0.5", price: 3_000_000 })),
    ).toEqual({ ok: true });
    expect(all("transactions")[0]).toMatchObject({ asset: "crypto:bitcoin", quantity: 0.5, fee: 0, amount: -1_500_000 });
    expect(all("crypto_holdings")[0]).toMatchObject({ coin_id: "bitcoin", symbol: "BTC", amount: 0.5, avg_cost_twd: 3_000_000, location: "冷錢包" });
  });
});

describe("saveFuturesPosition", () => {
  it("validates positions", async () => {
    mockMarketData();
    const base = { account_id: 1, coin: "btc", side: "long", quantity: 1, entry_price: 90_000 };
    expect(await saveFuturesPosition(null, form({ ...base, quantity: 0 }))).toEqual({ ok: false, error: "數量：必須大於 0" });
    expect(await saveFuturesPosition(null, form({ ...base, leverage: 0.5 }))).toEqual({ ok: false, error: "槓桿：槓桿至少 1" });
    expect(await saveFuturesPosition(null, form({ ...base, side: "flat" }))).toEqual({ ok: false, error: "方向：請選擇多或空" });
  });
});

describe("saveTwFutures", () => {
  it("needs equity for a manual account, and the sidecar for a SinoPac one", async () => {
    expect(await saveTwFutures(null, form({ name: "台新", source: "manual" }))).toEqual({ ok: false, error: "權益數：必填" });
    expect(await saveTwFutures(null, form({ name: "永豐", source: "sinopac" }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("SINOPAC_URL"),
    });
    expect(await saveTwFutures(null, form({ name: "台新", source: "manual", equity: "250,000" }))).toEqual({ ok: true });
    expect(all("tw_futures_accounts")).toMatchObject([{ name: "台新", source: "manual", equity: 250_000 }]);
  });
});

describe("saveProperty", () => {
  it("stores the term in months and checks the date format", async () => {
    expect(
      await saveProperty(null, form({ name: "家", cash_invested: 3_000_000, loan_amount: 7_000_000, annual_rate: 2.1, term_years: 30 })),
    ).toEqual({ ok: true });
    expect(all("properties")[0]).toMatchObject({ term_months: 360, grace_months: 0, loan_start_date: null });
    expect(
      await saveProperty(
        null,
        form({ name: "家", cash_invested: 1, loan_amount: 1, annual_rate: 1, term_years: 20, loan_start_date: "2024/01/01" }),
      ),
    ).toEqual({ ok: false, error: "撥款日：日期格式 YYYY-MM-DD" });
  });
});

describe("deleteItem", () => {
  it("deletes an account with its transactions, or one transaction", async () => {
    mockMarketData();
    await saveCash(null, form({ name: "a", currency: "TWD", balance: 1 }));
    const id = all("accounts")[0].id as number;
    expect(await deleteItem("account", id)).toEqual({ ok: true });
    expect([all("accounts"), all("transactions"), all("cash_accounts")]).toEqual([[], [], []]);

    await saveTransaction(null, form({ kind: "stock", account: "國泰", type: "buy", symbol: "2330", date: "2026-10-01", quantity: 1, price: 1 }));
    await saveTransaction(null, form({ kind: "stock", account: "國泰", type: "sell", symbol: "2330", date: "2026-10-02", quantity: 1, price: 1 }));
    const [buy, sell] = all("transactions").map((t) => t.id as number);
    expect(await deleteItem("transaction", buy)).toMatchObject({ ok: false, error: expect.stringContaining("負數") });
    expect(await deleteItem("transaction", sell)).toEqual({ ok: true });
    expect(all("stock_holdings")).toMatchObject([{ shares: 1 }]);
    expect(await deleteItem("nope" as "account", 1)).toEqual({ ok: false, error: "unknown kind" });
  });
});

describe("setLedgerMode", () => {
  it("switches to the ledger only after a week of agreement, and back any time", async () => {
    expect(await setLedgerMode("primary")).toMatchObject({ ok: false, error: expect.stringContaining("7 天") });
    setSetting("ledger_started_at", new Date(Date.now() - 8 * 86_400_000).toISOString());
    recordRun("ledger:compare", null);
    expect(await setLedgerMode("primary")).toEqual({ ok: true });
    expect(ledgerMode()).toBe("primary");
    expect(await setLedgerMode("shadow")).toEqual({ ok: true });
    expect(ledgerMode()).toBe("shadow");
  });
});

describe("snapshotNow / sendTestNotification", () => {
  it("records a manual snapshot like the scheduled one", async () => {
    mockFetch([[/./, () => new Response("down", { status: 503 })]]);
    expect(await snapshotNow()).toEqual({ ok: true });
    expect(getRuns().get("snapshot")?.failing).toBe(0);
  });

  it("explains a missing Telegram setup, and sends when configured", async () => {
    expect(await sendTestNotification()).toMatchObject({ ok: false, error: expect.stringContaining("TELEGRAM_BOT_TOKEN") });
    const tg = mockTelegram();
    expect(await sendTestNotification()).toEqual({ ok: true });
    expect(tg.texts()[0]).toContain("測試訊息");
  });
});
