import { beforeEach, describe, expect, it, vi } from "vitest";
import { insert, mockTelegram, resetDb } from "@/test/helpers";
import type { SnapshotRow } from "./db";
import { digestMessage, digestMode, sendDigest } from "./digest";

beforeEach(resetDb);

const snap = (date: string, v: Partial<SnapshotRow> = {}): SnapshotRow => {
  const row = { cash: 100_000, stocks: 500_000, crypto: 200_000, tw_futures: 0, real_estate: 0, mortgage: 0, ...v };
  const assets = row.cash + row.stocks + row.crypto + row.tw_futures + row.real_estate;
  return {
    date,
    total_assets: assets,
    total_liabilities: row.mortgage,
    net_worth: assets - row.mortgage,
    detail: "{}",
    created_at: `${date} 15:55:00`,
    ...row,
  };
};

const prev = snap("2026-10-25");
const today = snap("2026-10-26", { stocks: 510_000, crypto: 190_000, cash: 108_000 });

describe("digestMessage", () => {
  it("shows only percentages by default", () => {
    expect(digestMessage(today, prev, "pct")).toBe(
      // Biggest move first; equal moves keep category order.
      ["📊 10/26 淨資產 ▲ +1.00%（較 10/25）", "股票 ▲ 2.00%｜加密貨幣 ▼ 5.00%｜現金 ▲ 8.00%"].join("\n"),
    );
  });

  it("includes amounts in full mode", () => {
    expect(digestMessage(today, prev, "full")).toBe(
      [
        "📊 10/26 淨資產 NT$808,000",
        "較 10/25 ▲ NT$8,000（+1.00%）",
        "股票 ▲ NT$10,000｜加密貨幣 ▼ NT$10,000｜現金 ▲ NT$8,000",
      ].join("\n"),
    );
  });

  it("handles the first snapshot, a new category, and open alerts", () => {
    expect(digestMessage(today, undefined, "pct")).toBe("📊 10/26 已記錄快照");
    const withFutures = snap("2026-10-26", { tw_futures: 50_000 });
    expect(digestMessage(withFutures, prev, "pct", 2)).toBe(
      ["📊 10/26 淨資產 ▲ +6.25%（較 10/25）", "期貨 ▲ 新增", "⚠️ 目前有 2 個未解除的告警"].join("\n"),
    );
  });
});

describe("sendDigest", () => {
  it("sends silently, comparing with the previous snapshot", async () => {
    insert("snapshots", prev as unknown as Record<string, unknown>);
    const tg = mockTelegram();
    await sendDigest(today);
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0].body).toMatchObject({ disable_notification: true, text: expect.stringContaining("較 10/25") });
  });

  it("can be turned off", async () => {
    vi.stubEnv("TELEGRAM_DIGEST", "off");
    expect(digestMode()).toBe("off");
    const tg = mockTelegram();
    await sendDigest(today);
    expect(tg.calls).toHaveLength(0);
  });
});
