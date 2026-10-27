import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/test/helpers";
import { getRuns, isFailing, recordRun, tracked } from "./jobs";

beforeEach(resetDb);

describe("job runs", () => {
  it("records success and failure, keeping the last error after a recovery", () => {
    recordRun("feed:tw", null, new Date("2026-10-26T01:00:00Z"));
    expect(isFailing(getRuns().get("feed:tw"))).toBe(false);

    recordRun("feed:tw", "FinMind 502", new Date("2026-10-26T01:05:00Z"));
    expect(getRuns().get("feed:tw")).toMatchObject({
      last_ok_at: "2026-10-26T01:00:00.000Z",
      last_error_at: "2026-10-26T01:05:00.000Z",
      last_error: "FinMind 502",
    });
    expect(isFailing(getRuns().get("feed:tw"))).toBe(true);

    recordRun("feed:tw", "", new Date("2026-10-26T01:10:00Z"));
    const run = getRuns().get("feed:tw")!;
    expect(isFailing(run)).toBe(false);
    expect(run.last_error).toBe("FinMind 502");
    expect(run.last_run_at).toBe("2026-10-26T01:10:00.000Z");
  });

  it("tracked() records the outcome and passes results and errors through", async () => {
    await expect(tracked("snapshot", () => 7)).resolves.toBe(7);
    expect(isFailing(getRuns().get("snapshot"))).toBe(false);

    await expect(
      tracked("snapshot", async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(getRuns().get("snapshot")?.last_error).toBe("disk full");
    expect(isFailing(getRuns().get("snapshot"))).toBe(true);
  });

  it("treats a job that never ran as not failing", () => {
    expect(isFailing(undefined)).toBe(false);
  });
});
