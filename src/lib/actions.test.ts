import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch, mockTelegram, resetDb } from "@/test/helpers";
import {
  deleteItem,
  login,
  saveCash,
  saveCrypto,
  saveFuturesPosition,
  saveProperty,
  saveStock,
  saveTwFutures,
  sendTestNotification,
  snapshotNow,
} from "./actions";
import { db } from "./db";
import { getRuns } from "./jobs";
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
    await expect(deleteItem("cash", 1)).rejects.toThrow("Unauthorized");
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
    expect(all("cash_accounts")[0]).toMatchObject({ currency: "USD", balance: 1234.5, institution: null });
  });

  it("updates in place and reports the field that failed validation", async () => {
    mockMarketData();
    await saveCash(null, form({ name: "薪轉", currency: "TWD", balance: 1 }));
    const id = all("cash_accounts")[0].id as number;
    await saveCash(null, form({ id, name: "薪轉", currency: "TWD", balance: 2 }));
    expect(all("cash_accounts")).toMatchObject([{ balance: 2 }]);
    expect(await saveCash(null, form({ name: "x", currency: "US", balance: 1 }))).toEqual({
      ok: false,
      error: "幣別：三碼幣別，如 TWD / USD",
    });
    expect(await saveCash(null, form({ name: "x", currency: "TWD", balance: "abc" }))).toMatchObject({ ok: false, error: "餘額：請輸入數字" });
  });
});

describe("saveStock", () => {
  it("looks up the Chinese name and validates the symbol", async () => {
    mockMarketData();
    expect(await saveStock(null, form({ symbol: "2330", shares: "1,000", avg_cost: "" }))).toEqual({ ok: true });
    expect(all("stock_holdings")[0]).toMatchObject({ symbol: "2330", name: "台積電", shares: 1_000, avg_cost: null });
    expect(await saveStock(null, form({ symbol: "AB", shares: 1 }))).toMatchObject({ ok: false, error: expect.stringMatching(/^股票代號：/) });
  });
});

describe("saveCrypto / saveFuturesPosition", () => {
  it("resolves a ticker to the CoinGecko coin with the highest market cap", async () => {
    mockMarketData();
    expect(await saveCrypto(null, form({ coin: "BTC", amount: "0.5" }))).toEqual({ ok: true });
    expect(all("crypto_holdings")[0]).toMatchObject({ coin_id: "bitcoin", symbol: "BTC", amount: 0.5 });
  });

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
  it("deletes from the table for that kind only", async () => {
    mockMarketData();
    await saveCash(null, form({ name: "a", currency: "TWD", balance: 1 }));
    const id = all("cash_accounts")[0].id as number;
    expect(await deleteItem("cash", id)).toEqual({ ok: true });
    expect(all("cash_accounts")).toEqual([]);
    expect(await deleteItem("nope" as "cash", 1)).toEqual({ ok: false, error: "unknown kind" });
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
