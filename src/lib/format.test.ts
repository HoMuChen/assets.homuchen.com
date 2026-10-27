import { describe, expect, it } from "vitest";
import { fmtCompact, fmtNum, fmtPct, fmtPrice, fmtTime, fmtTwd, fmtUsdt } from "./format";

describe("formatters", () => {
  it("fmtTwd rounds to whole dollars and keeps the sign outside the unit", () => {
    expect(fmtTwd(1234567.6)).toBe("NT$1,234,568");
    expect(fmtTwd(-500)).toBe("-NT$500");
    expect(fmtTwd(null)).toBe("—");
    expect(fmtTwd(Number.NaN)).toBe("—");
  });

  it("fmtCompact uses 萬 and 億 for chart axes", () => {
    expect(fmtCompact(1_234_567)).toBe("123萬");
    expect(fmtCompact(54_321)).toBe("5.4萬");
    expect(fmtCompact(120_000_000)).toBe("1.2億");
    expect(fmtCompact(-2_500_000_000)).toBe("-25億");
    expect(fmtCompact(999)).toBe("999");
  });

  it("fmtPct signs changes but not shares", () => {
    expect(fmtPct(1.234)).toBe("+1.23%");
    expect(fmtPct(-0.5)).toBe("-0.50%");
    expect(fmtPct(0)).toBe("0.00%");
    expect(fmtPct(12.5, false)).toBe("12.50%");
    expect(fmtPct(undefined)).toBe("—");
  });

  it("fmtPrice picks precision by magnitude", () => {
    expect(fmtPrice(1_005)).toBe("1,005");
    expect(fmtPrice(45.6)).toBe("45.60");
    expect(fmtPrice(0.000123)).toBe("0.000123");
    expect(fmtNum(1234.56789, 2)).toBe("1,234.57");
    expect(fmtUsdt(-1234.5)).toBe("-1,234.50");
  });

  it("fmtTime renders Taipei time independent of the host time zone", () => {
    expect(fmtTime("2026-10-26T01:02:03Z")).toBe("10/26 09:02:03");
    expect(fmtTime(null)).toBe("—");
  });
});
