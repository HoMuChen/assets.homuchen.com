import { beforeEach, describe, expect, it, vi } from "vitest";
import { insert, mockFetch, resetDb } from "@/test/helpers";
import { db, type TwFuturesAccount } from "./db";
import { getRuns } from "./jobs";
import { sinopacBackingOff, syncSinopac } from "./tw-futures";

const g = globalThis as unknown as { __sinopacFailedAt?: number };

beforeEach(() => {
  resetDb();
  g.__sinopacFailedAt = undefined;
  vi.stubEnv("SINOPAC_URL", "http://sinopac:8000");
});

const row = (id: number) => db().prepare("SELECT * FROM tw_futures_accounts WHERE id = ?").get(id) as TwFuturesAccount;
const margin = (account_id: string, equity: number) => ({
  account_id,
  equity,
  future_open_position: 1_500,
  option_open_position: -500,
  available_margin: 200_000,
  initial_margin: 300_000,
  maintenance_margin: 230_000,
  risk_indicator: 166.7,
  margin_call: 0,
});

describe("syncSinopac", () => {
  it("claims the first unclaimed futures account and stores its margin", async () => {
    const id = insert("tw_futures_accounts", { name: "永豐期貨", source: "sinopac" });
    mockFetch([["sinopac:8000/margin", () => Response.json({ accounts: [margin("F0001", 500_000)] })]]);

    expect(await syncSinopac()).toEqual({ synced: 1, error: null });
    expect(row(id)).toMatchObject({
      account_ref: "F0001",
      equity: 500_000,
      open_pnl: 1_000,
      risk_indicator: 166.7,
      sync_error: null,
    });
    expect(getRuns().get("sync:sinopac")?.failing).toBe(0);
  });

  it("keeps the last equity on failure, records the error, and backs off", async () => {
    const id = insert("tw_futures_accounts", { name: "永豐期貨", source: "sinopac", account_ref: "F0001", equity: 480_000 });
    mockFetch([["sinopac:8000/margin", () => Response.json({ error: "TimeoutError" }, { status: 502 })]]);

    const r = await syncSinopac();
    expect(r.error).toContain("TimeoutError");
    expect(row(id)).toMatchObject({ equity: 480_000, sync_error: expect.stringContaining("TimeoutError") });
    expect(getRuns().get("sync:sinopac")?.failing).toBe(1);
    expect(sinopacBackingOff()).toBe(true);
  });

  it("shares one sidecar call between concurrent callers", async () => {
    insert("tw_futures_accounts", { name: "永豐期貨", source: "sinopac" });
    const calls = mockFetch([["sinopac:8000/margin", () => Response.json({ accounts: [margin("F0001", 1)] })]]);
    await Promise.all([syncSinopac(), syncSinopac(), syncSinopac()]);
    expect(calls).toHaveLength(1);
  });

  it("does nothing without SinoPac accounts", async () => {
    const calls = mockFetch([]);
    expect(await syncSinopac()).toEqual({ synced: 0, error: null });
    expect(calls).toHaveLength(0);
    expect(getRuns().has("sync:sinopac")).toBe(false);
  });
});
