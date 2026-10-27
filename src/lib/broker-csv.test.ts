import { describe, expect, it } from "vitest";
import { CsvError, decodeCsv, parseBrokerCsv, parseCsv, parseDate, parseNumber } from "./broker-csv";

describe("decodeCsv", () => {
  it("reads UTF-8 (dropping a BOM) and falls back to Big5, as Excel saves it", () => {
    expect(decodeCsv(new TextEncoder().encode("﻿股票代號,股數"))).toBe("股票代號,股數");
    // 股票代號 in Big5
    expect(decodeCsv(Uint8Array.from([0xaa, 0xd1, 0xb2, 0xbc, 0xa5, 0x4e, 0xb8, 0xb9]))).toBe("股票代號");
  });
});

describe("parseCsv", () => {
  it("handles quotes, CRLF, blank lines and Excel's =\"…\" codes", () => {
    expect(parseCsv('代號,名稱,金額\r\n="0050","元大台灣50","1,234"\r\n\r\n2330,"台積""電",5\r\n')).toEqual([
      ["代號", "名稱", "金額"],
      ["0050", "元大台灣50", "1,234"],
      ["2330", '台積"電', "5"],
    ]);
  });

  it("guesses a tab or semicolon delimiter", () => {
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("values", () => {
  it("parses Gregorian, ROC and compact dates, ignoring a time", () => {
    expect(parseDate("2026/10/27")).toBe("2026-10-27");
    expect(parseDate("2026-1-5 09:30:00")).toBe("2026-01-05");
    expect(parseDate("115/10/27")).toBe("2026-10-27");
    expect(parseDate("115年10月27日")).toBe("2026-10-27");
    expect(parseDate("20261027")).toBe("2026-10-27");
    expect(parseDate("2026/02/30")).toBeNull();
    expect(parseDate("昨天")).toBeNull();
  });

  it("parses thousands separators, currency marks and accounting negatives", () => {
    expect(parseNumber("1,000")).toBe(1000);
    expect(parseNumber("$1,234.5")).toBe(1234.5);
    expect(parseNumber("(20)")).toBe(-20);
    expect(parseNumber("1,000 股")).toBe(1000);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("-")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
  });
});

describe("parseBrokerCsv", () => {
  it("reads a trades export below a preamble, by the names brokers give the columns", () => {
    const csv = [
      "國泰證券 成交明細",
      "查詢期間,2026/10/01~2026/10/27",
      "成交日期,股票代號,股票名稱,買賣別,成交股數,成交價(元),手續費,交易稅",
      '2026/10/20,="2330",台積電,現股買進,"1,000",1000,1425,0',
      "115/10/21,0050 元大台灣50,,現賣,500,180.5,,",
      "2026/10/22,2317,鴻海,融資買進,1000,200,285,0",
      "2026/10/22,2454,聯發科,沖銷,100,1200,171,0",
      "合計,,,,,,1881,0",
    ].join("\n");
    const r = parseBrokerCsv(csv);
    expect(r.kind).toBe("trades");
    expect(r.columns).toEqual(expect.arrayContaining(["成交日期", "股票代號", "買賣別", "成交股數", "成交價(元)"]));
    expect(r.rows).toEqual([
      { line: 4, date: "2026-10-20", symbol: "2330", name: "台積電", side: "buy", quantity: 1000, price: 1000, fee: 1425, tax: 0 },
      { line: 5, date: "2026-10-21", symbol: "0050", name: null, side: "sell", quantity: 500, price: 180.5, fee: null, tax: null },
    ]);
    expect(r.errors).toEqual([
      { line: 6, message: expect.stringContaining("信用交易") },
      { line: 7, message: "2454：看不懂買賣別「沖銷」" },
    ]);
  });

  it("converts board lots to shares, and reports rows it can't read", () => {
    const r = parseBrokerCsv(["交易日期,證券代號,買/賣,成交張數,成交價", "2026-10-20,2330,買,2,1000", "2026-13-01,2330,買,1,1000", "2026-10-20,2330,賣,0,1000"].join("\n"));
    expect(r.rows).toMatchObject([{ symbol: "2330", side: "buy", quantity: 2000 }]);
    expect(r.errors.map((e) => e.message)).toEqual(["2330：看不懂日期「2026-13-01」", "2330：股數要大於 0"]);
  });

  it("reads a holdings statement, adding up a stock listed twice", () => {
    const r = parseBrokerCsv(
      ["股票代號,股票名稱,庫存股數,成本均價", "2330,台積電,1000,600", "2330,台積電,35,980", "0056,元大高股息,(5),30", "2603,長榮,融資 1000,150"].join("\n"),
    );
    expect(r.kind).toBe("holdings");
    expect(r.rows).toEqual([{ line: 2, symbol: "2330", name: "台積電", quantity: 1035, avgCost: 600 }]);
    expect(r.errors.map((e) => e.message)).toEqual(["0056：看不懂庫存股數「(5)」", expect.stringContaining("信用交易")]);
  });

  it("takes a bare 股數 column as the holding when there are no trade columns", () => {
    const r = parseBrokerCsv("代號,名稱,股數\n2330,台積電,10");
    expect(r).toMatchObject({ kind: "holdings", rows: [{ symbol: "2330", quantity: 10 }] });
  });

  it("explains what it needs when it can't find the columns", () => {
    expect(() => parseBrokerCsv("日期,金額\n2026-10-20,100")).toThrow(CsvError);
    expect(() => parseBrokerCsv("日期,金額\n2026-10-20,100")).toThrow(/檔案開頭是：日期、金額/);
    expect(() => parseBrokerCsv("")).toThrow(/（空的）/);
  });
});
