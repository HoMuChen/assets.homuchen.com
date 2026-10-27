import { describe, expect, it } from "vitest";
import { at } from "@/test/helpers";
import { isTwFuturesOpen, isTwMarketOpen, taipeiDate } from "./time";

// 2026-10-26 is a Monday.

describe("taipeiDate", () => {
  it("rolls over at midnight Taipei, not UTC", () => {
    expect(taipeiDate(new Date("2026-10-25T15:59:00Z"))).toBe("2026-10-25");
    expect(taipeiDate(new Date("2026-10-25T16:00:00Z"))).toBe("2026-10-26");
  });
});

describe("isTwMarketOpen", () => {
  it.each([
    ["2026-10-26 08:59", false],
    ["2026-10-26 09:00", true],
    ["2026-10-26 13:35", true],
    ["2026-10-26 13:36", false],
    ["2026-10-31 10:00", false], // Saturday
    ["2026-11-01 10:00", false], // Sunday
  ])("%s → %s", (time, open) => {
    expect(isTwMarketOpen(at(time))).toBe(open);
  });
});

describe("isTwFuturesOpen", () => {
  it.each([
    ["2026-10-26 03:00", false], // Monday early morning: no Sunday-night session
    ["2026-10-26 08:44", false],
    ["2026-10-26 08:45", true],
    ["2026-10-26 13:45", true],
    ["2026-10-26 14:30", false], // between sessions
    ["2026-10-26 15:00", true], // after-hours session
    ["2026-10-27 04:59", true], // Monday's night session runs into Tuesday
    ["2026-10-27 05:01", false],
    ["2026-10-31 04:00", true], // Friday's night session runs into Saturday
    ["2026-10-31 06:00", false],
    ["2026-11-01 12:00", false], // Sunday
  ])("%s → %s", (time, open) => {
    expect(isTwFuturesOpen(at(time))).toBe(open);
  });
});
