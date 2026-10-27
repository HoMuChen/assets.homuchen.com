import { beforeEach, describe, expect, it } from "vitest";
import { cashAccount, holding, insert, resetDb, setPrice } from "@/test/helpers";
import { getPortfolio } from "./portfolio";
import { setSetting } from "./settings";

beforeEach(resetDb);

// Both sources of holdings must value everything identically; that's what makes the switch safe.
describe.each(["shadow", "primary"] as const)("getPortfolio (%s)", (mode) => {
  beforeEach(() => {
    setSetting("ledger_mode", mode);
    cashAccount("薪轉", 100_000);
    cashAccount("美元戶", 1_000, "USD");
    setPrice("fx:USD", 32);

    holding("tw:2330", 1_000, 500, { name: "台積電" });
    setPrice("tw:2330", 1_000, { changePct: 2 });

    holding("crypto:bitcoin", 0.5, 2_000_000, { symbol: "BTC", name: "Bitcoin" });
    setPrice("crypto:bitcoin", 3_000_000, { changePct: -5 });
    setPrice("crypto:ethereum", 112_000);

    const acct = insert("futures_accounts", { name: "Bybit", wallet_balance: 1_000 });
    insert("futures_positions", {
      account_id: acct,
      coin_id: "bitcoin",
      symbol: "BTC",
      side: "long",
      quantity: 0.1,
      entry_price: 90_000,
      leverage: 10,
    });
    insert("futures_positions", { account_id: acct, coin_id: "ethereum", symbol: "ETH", side: "short", quantity: 1, entry_price: 4_000 });
    setPrice("crypto_usd:bitcoin", 100_000, { changePct: 1 });
    setPrice("crypto_usd:ethereum", 3_500);
    setPrice("crypto_usd:tether", 1);
    setPrice("crypto:tether", 32);

    insert("tw_futures_accounts", { name: "永豐期貨", source: "sinopac", equity: 300_000 });
    insert("properties", { name: "家", cash_invested: 3_000_000, loan_amount: 7_000_000, annual_rate: 2, term_months: 360 });
  });

  it("converts foreign cash at the FX quote", () => {
    const p = getPortfolio();
    expect(p.cash.map((c) => c.position.valueTwd)).toEqual(expect.arrayContaining([100_000, 32_000]));
    expect(p.totals.cash).toBe(132_000);
  });

  it("values stocks at the quote, with cost basis and the day's change backed out of change_pct", () => {
    const [stock] = getPortfolio().stocks;
    expect(stock).toMatchObject({ symbol: "2330", name: "台積電", account: "國泰", quantity: 1_000, avgCost: 500 });
    const s = stock.position;
    expect(s.valueTwd).toBe(1_000_000);
    expect(s.costTwd).toBe(500_000);
    expect(s.dayChangeTwd).toBeCloseTo(1_000_000 - 1_000_000 / 1.02, 6);
  });

  it("values USDT-margined futures at equity = wallet + unrealised PnL, converted at USDT/TWD", () => {
    const a = getPortfolio().futures[0];
    const [btc, eth] = a.positions;
    expect(btc.upnlUsdt).toBeCloseTo(1_000, 6); // 0.1 × (100,000 − 90,000)
    expect(btc.returnPct).toBeCloseTo((10_000 / 90_000) * 100 * 10, 6); // price move × leverage
    expect(eth.upnlUsdt).toBeCloseTo(500, 6); // short 1 × (4,000 − 3,500)
    expect(a.equityUsdt).toBeCloseTo(2_500, 6);
    expect(a.notionalUsdt).toBeCloseTo(13_500, 6);
    expect(a.effectiveLeverage).toBeCloseTo(5.4, 6);
    expect(a.position.valueTwd).toBeCloseTo(80_000, 6);
  });

  it("nets spot and futures into per-coin exposure", () => {
    const ex = getPortfolio().exposure;
    expect(ex.find((e) => e.coinId === "bitcoin")).toMatchObject({ spotQty: 0.5, netQty: 0.6, netValueTwd: 1_800_000 });
    expect(ex.find((e) => e.coinId === "ethereum")).toMatchObject({ futuresQty: -1, netValueTwd: -112_000 });
  });

  it("values property at cost without an appraisal and subtracts the mortgage from net worth", () => {
    const p = getPortfolio();
    expect(p.properties[0].marketValue).toBe(10_000_000);
    expect(p.properties[0].equity).toBe(3_000_000); // no start date yet: nothing repaid
    expect(p.totals).toMatchObject({
      cash: 132_000,
      stocks: 1_000_000,
      cryptoSpot: 1_500_000,
      twFutures: 300_000,
      realEstate: 10_000_000,
      mortgage: 7_000_000,
      totalLiabilities: 7_000_000,
    });
    expect(p.totals.crypto).toBeCloseTo(1_580_000, 6);
    expect(p.totals.totalAssets).toBeCloseTo(13_012_000, 6);
    expect(p.totals.netWorth).toBeCloseTo(6_012_000, 6);
    expect(p.missingPrices).toEqual([]);
  });

  it("counts a holding without any quote as 0 and lists it as missing", () => {
    holding("tw:0050", 100, null);
    const p = getPortfolio();
    expect(p.missingPrices).toContain("0050");
    expect(p.totals.stocks).toBe(1_000_000);
  });
});
