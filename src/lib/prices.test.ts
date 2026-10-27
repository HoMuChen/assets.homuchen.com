import { beforeEach, describe, expect, it } from "vitest";
import { insert, mockFetch, resetDb, setPrice } from "@/test/helpers";
import { getRuns, isFailing } from "./jobs";
import { getPriceMap, refreshPrices } from "./prices";

beforeEach(() => {
  resetDb();
  insert("stock_holdings", { symbol: "2330", shares: 1 });
  insert("crypto_holdings", { coin_id: "bitcoin", symbol: "btc", amount: 1 });
  insert("cash_accounts", { name: "美元戶", currency: "USD", balance: 1 });
});

const finmindSnapshot = (close: number, changeRate: number) =>
  ["taiwan_stock_tick_snapshot", () => Response.json({ status: 200, msg: "success", data: [{ close, change_rate: changeRate, date: "2026-10-26 10:00:00" }] })] as const;
const coingecko = () =>
  ["/simple/price", () => Response.json({ bitcoin: { twd: 3_000_000, usd: 95_000, twd_24h_change: 2, usd_24h_change: 2.1, last_updated_at: 1_793_000_000 } })] as const;
const erApi = () =>
  ["open.er-api.com", () => Response.json({ result: "success", rates: { USD: 1, TWD: 32.5 }, time_last_update_utc: "Mon, 26 Oct 2026 00:00:01 +0000" })] as const;

describe("refreshPrices", () => {
  it("stores quotes from every feed and records each feed as healthy", async () => {
    mockFetch([finmindSnapshot(1_005, 1.5), coingecko(), erApi()]);
    const r = await refreshPrices({ force: true });

    expect(r).toEqual({ updated: 4, errors: [] });
    const prices = getPriceMap();
    expect(prices.get("tw:2330")).toMatchObject({ price: 1_005, change_pct: 1.5, source: "finmind:snapshot" });
    expect(prices.get("crypto:bitcoin")).toMatchObject({ price: 3_000_000, change_pct: 2 });
    expect(prices.get("crypto_usd:bitcoin")).toMatchObject({ price: 95_000 });
    expect(prices.get("fx:USD")?.price).toBeCloseTo(32.5, 10);
    const runs = getRuns();
    for (const feed of ["feed:tw", "feed:crypto", "feed:fx"]) expect(isFailing(runs.get(feed))).toBe(false);
  });

  it("falls back to the latest daily close when the real-time snapshot has nothing", async () => {
    mockFetch([
      ["taiwan_stock_tick_snapshot", () => Response.json({ status: 200, msg: "", data: [] })],
      ["dataset=TaiwanStockPrice", () => Response.json({ status: 200, msg: "", data: [{ close: 990, spread: 10, date: "2026-10-23" }] })],
      coingecko(),
      erApi(),
    ]);
    await refreshPrices({ force: true });
    const q = getPriceMap().get("tw:2330")!;
    expect(q).toMatchObject({ price: 990, source: "finmind:daily" });
    expect(q.change_pct).toBeCloseTo((10 / 980) * 100, 10);
  });

  it("keeps the last good quote when a feed fails, and records the failure", async () => {
    setPrice("crypto:bitcoin", 2_900_000, { fetchedAt: new Date("2026-10-26T00:00:00Z") });
    mockFetch([
      finmindSnapshot(1_000, 0),
      ["/simple/price", () => new Response("rate limited", { status: 429, statusText: "Too Many Requests" })],
      erApi(),
    ]);
    const r = await refreshPrices({ force: true });

    expect(r.errors).toEqual([expect.stringContaining("加密貨幣: 429")]);
    expect(getPriceMap().get("crypto:bitcoin")?.price).toBe(2_900_000);
    expect(getRuns().get("feed:crypto")).toMatchObject({ failing: 1, last_error: expect.stringContaining("429") });
    expect(isFailing(getRuns().get("feed:tw"))).toBe(false);
  });

  it("skips quotes that are still fresh", async () => {
    setPrice("tw:2330", 1_000);
    setPrice("crypto:bitcoin", 3_000_000);
    setPrice("crypto_usd:bitcoin", 95_000);
    setPrice("fx:USD", 32);
    const calls = mockFetch([]);
    expect(await refreshPrices()).toEqual({ updated: 0, errors: [] });
    expect(calls).toHaveLength(0);
  });
});
