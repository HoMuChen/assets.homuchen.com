import { describe, expect, it } from "vitest";
import { isTwEtf, twTradeCosts, twTransactionTaxRate } from "./fees";

describe("twTradeCosts", () => {
  it("charges 0.1425% rounded down, with the board-lot and odd-lot minimums", () => {
    expect(twTradeCosts({ side: "buy", symbol: "2330", shares: 1_000, price: 1_000, date: "2026-10-26" })).toEqual({ fee: 1_425, tax: 0 });
    expect(twTradeCosts({ side: "buy", symbol: "2330", shares: 1_000, price: 10, date: "2026-10-26" })).toEqual({ fee: 20, tax: 0 });
    expect(twTradeCosts({ side: "buy", symbol: "2330", shares: 3, price: 100, date: "2026-10-26" })).toEqual({ fee: 1, tax: 0 });
  });

  it("applies the account's discount before rounding", () => {
    // 550,000 × 0.001425 × 0.28 = 219.45
    expect(twTradeCosts({ side: "buy", symbol: "2330", shares: 500, price: 1_100, date: "2026-10-26", feeDiscount: 0.28 }).fee).toBe(219);
  });

  it("taxes sells at 0.3% for shares and 0.1% for ETFs", () => {
    expect(twTradeCosts({ side: "sell", symbol: "2330", shares: 1_000, price: 1_000, date: "2026-10-26" }).tax).toBe(3_000);
    expect(twTradeCosts({ side: "sell", symbol: "0050", shares: 1_000, price: 200, date: "2026-10-26" }).tax).toBe(200);
  });

  it("knows bond ETFs are exempt only through 2026", () => {
    expect(isTwEtf("00679B")).toBe(true);
    expect(twTransactionTaxRate("00679B", "2026-12-31")).toBe(0);
    expect(twTransactionTaxRate("00679B", "2027-01-02")).toBe(0.001);
    expect(twTransactionTaxRate("2330", "2027-01-02")).toBe(0.003);
  });

  it("costs nothing for an empty trade", () => {
    expect(twTradeCosts({ side: "sell", symbol: "2330", shares: 0, price: 1_000, date: "2026-10-26" })).toEqual({ fee: 0, tax: 0 });
  });
});
