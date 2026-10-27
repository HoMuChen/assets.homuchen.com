import { beforeEach, describe, expect, it } from "vitest";
import { insert, mockFetch, resetDb, setPrice } from "@/test/helpers";
import { getSnapshots, hasSnapshot, takeSnapshot } from "./snapshot";
import { taipeiDate } from "./time";

beforeEach(resetDb);

describe("takeSnapshot", () => {
  it("writes today's totals from the last good quotes even when every feed is down", async () => {
    insert("cash_accounts", { name: "薪轉", currency: "TWD", balance: 50_000 });
    insert("stock_holdings", { symbol: "2330", name: "台積電", shares: 100 });
    setPrice("tw:2330", 1_000);
    insert("properties", { name: "家", cash_invested: 1_000_000, loan_amount: 4_000_000, annual_rate: 2, term_months: 360 });
    mockFetch([[/./, () => new Response("down", { status: 503 })]]);

    const row = await takeSnapshot();

    expect(row).toMatchObject({
      date: taipeiDate(),
      cash: 50_000,
      stocks: 100_000,
      real_estate: 5_000_000,
      mortgage: 4_000_000,
      net_worth: 1_150_000,
    });
    const detail = JSON.parse(row.detail);
    expect(detail.positions).toContainEqual(expect.objectContaining({ key: expect.stringMatching(/^tw:/), quantity: 100, price: 1_000 }));
    expect(detail.properties[0]).toMatchObject({ equity: 1_000_000 });
  });

  it("overwrites the same day instead of adding a row", async () => {
    mockFetch([[/./, () => new Response("down", { status: 503 })]]);
    insert("cash_accounts", { name: "薪轉", currency: "TWD", balance: 1 });
    await takeSnapshot();
    insert("cash_accounts", { name: "定存", currency: "TWD", balance: 2 });
    await takeSnapshot();

    const rows = getSnapshots();
    expect(rows).toHaveLength(1);
    expect(rows[0].cash).toBe(3);
    expect(hasSnapshot(taipeiDate())).toBe(true);
  });
});
