import { beforeEach, describe, expect, it, vi } from "vitest";
import { at, holding, resetDb, tx } from "@/test/helpers";
import { db, type Transaction } from "./db";
import { twTradeCosts } from "./fees";
import { importHoldings, importTrades, previewImport } from "./import";
import { openItems } from "./inbox";
import { instruments, seriesAt } from "./ledger";
import { addTransaction } from "./transactions";

beforeEach(resetDb);

const NOW = at("2026-10-27 12:00");
const noName = vi.fn(async () => null);
const trades = (...rows: string[]) => ["成交日期,股票代號,股票名稱,買賣別,成交股數,成交價,手續費,交易稅", ...rows].join("\n");
const imported = () => db().prepare("SELECT * FROM transactions WHERE source = 'import' ORDER BY id").all() as Transaction[];

describe("previewImport", () => {
  it("fills in the broker's usual costs when the file has none, against an account that doesn't exist yet", () => {
    const p = previewImport(trades("2026-10-20,2330,台積電,買進,1000,1000,,", "2026-10-21,2330,台積電,賣出,1000,1100,1500,3300"), "國泰", "2026-10-27");
    expect(p.kind).toBe("trades");
    if (p.kind !== "trades") return;
    const auto = twTradeCosts({ side: "buy", symbol: "2330", shares: 1000, price: 1000, date: "2026-10-20" });
    expect(p.rows).toMatchObject([
      { status: "new", fee: auto.fee, tax: 0, externalId: "new:2026-10-20:2330:buy:1000:1000:1" },
      { status: "new", fee: 1500, tax: 3300 },
    ]);
  });

  it("tells identical fills on one day apart by their order", () => {
    const p = previewImport(trades("2026-10-20,2330,,買,1,1000,1,0", "2026-10-20,2330,,買,1,1000,1,0"), "國泰", "2026-10-27");
    expect(p.kind === "trades" && p.rows.map((r) => r.externalId.split(":").at(-1))).toEqual(["1", "2"]);
  });

  it("flags a trade that looks like one already entered by hand", () => {
    const id = holding("tw:2330", 0, null);
    addTransaction({ ...tx("buy", id, "tw:2330", 1000, 1000), date: "2026-10-20" });
    const p = previewImport(trades("2026-10-20,2330,,買,1000,1000,1425,0"), "國泰", "2026-10-27");
    expect(p.kind === "trades" && p.rows[0].status).toBe("similar");
  });
});

describe("importTrades", () => {
  it("writes each trade once, however often the file is imported", async () => {
    const file = trades("2026-10-20,2330,台積電,買進,1000,1000,1425,0");
    expect(await importTrades(file, "國泰", null, noName, NOW)).toEqual({ added: 1, skipped: 0, failed: [] });
    expect(imported()).toMatchObject([{ type: "buy", asset: "tw:2330", quantity: 1000, price: 1000, amount: -1_001_425, fee: 1425 }]);
    expect(await importTrades(file, "國泰", null, noName, NOW)).toEqual({ added: 0, skipped: 1, failed: [] });
    const p = previewImport(file, "國泰", "2026-10-27");
    expect(p.kind === "trades" && p.rows[0].status).toBe("imported");
  });

  it("puts a day trade's buy before its sell, whatever the file's order", async () => {
    const file = trades("2026-10-20,2330,,賣出,1000,1010,1439,1515", "2026-10-20,2330,,買進,1000,1000,1425,0");
    const r = await importTrades(file, "國泰", null, async () => "台積電", NOW);
    expect(r.added).toBe(2);
    expect(imported().map((t) => t.type)).toEqual(["buy", "sell"]);
    expect(instruments().get("tw:2330")?.name).toBe("台積電");
  });

  it("imports only the chosen lines, and reports the ones the ledger refuses", async () => {
    const file = trades("2026-10-20,2330,,賣出,1000,1000,1425,3000", "2026-10-21,0050,,買進,100,180,20,0", "2026-10-22,2317,,買進,100,200,20,0");
    const r = await importTrades(file, "國泰", new Set([2, 3]), noName, NOW);
    expect(r.added).toBe(1);
    expect(r.failed).toEqual([{ line: 2, message: expect.stringMatching(/^2330 2026-10-20：/) }]);
    expect(imported().map((t) => t.asset)).toEqual(["tw:0050"]);
  });

  it("refuses a holdings file", async () => {
    await expect(importTrades("股票代號,庫存股數\n2330,1000", "國泰", null, noName, NOW)).rejects.toThrow("這個檔案是庫存");
  });
});

describe("importHoldings", () => {
  it("lists what differs from the ledger as of the statement's date, including holdings the statement left out", () => {
    const id = holding("tw:2330", 1000, 600, { account: "國泰" });
    holding("tw:0050", 200, 150, { account: "國泰" });
    holding("tw:2603", 50, 100, { account: "國泰" });
    const file = "股票代號,股票名稱,庫存股數\n2330,台積電,1000\n2603,長榮,80\n2454,聯發科,10";

    const p = previewImport(file, "國泰", "2026-10-27");
    expect(p.kind === "holdings" && p.rows.map((r) => [r.symbol, r.diff])).toEqual([
      ["2330", 0],
      ["2603", 30],
      ["2454", 10],
      ["0050", -200],
    ]);

    expect(importHoldings(file, "國泰", "2026-10-27", NOW)).toEqual({ added: 0, skipped: 0, failed: [], reported: 3 });
    expect(openItems(NOW).map((i) => [i.symbol, i.quantity])).toEqual([
      ["2603", 30],
      ["2454", 10],
      ["0050", -200],
    ]);
    expect(seriesAt(id, "tw:2330", "2026-10-27").quantity).toBe(1000); // nothing written yet
  });

  it("refuses a trades file", () => {
    expect(() => importHoldings(trades("2026-10-20,2330,,買,1,1000,1,0"), "國泰", "2026-10-27", NOW)).toThrow("這個檔案是成交明細");
  });
});
