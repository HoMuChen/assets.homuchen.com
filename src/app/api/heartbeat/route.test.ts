import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeAlerts } from "@/lib/alerts";
import { getRuns } from "@/lib/jobs";
import { resetDb } from "@/test/helpers";
import { POST } from "./route";

beforeEach(resetDb);

const post = (body: unknown, token = "secret") =>
  POST(
    new Request("http://127.0.0.1:3100/api/heartbeat", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("POST /api/heartbeat", () => {
  it("does not exist unless HEARTBEAT_TOKEN is set", async () => {
    expect((await post({ job: "backup", ok: true })).status).toBe(404);
  });

  it("rejects a wrong token and malformed bodies", async () => {
    vi.stubEnv("HEARTBEAT_TOKEN", "secret");
    expect((await post({ job: "backup", ok: true }, "nope")).status).toBe(401);
    expect((await post("not json")).status).toBe(400);
    expect((await post({ job: "rm -rf", ok: true })).status).toBe(400);
    expect(getRuns().size).toBe(0);
  });

  it("records a success", async () => {
    vi.stubEnv("HEARTBEAT_TOKEN", "secret");
    expect((await post({ job: "backup", ok: true })).status).toBe(200);
    expect(getRuns().get("backup")).toMatchObject({ failing: 0, last_ok_at: expect.any(String) });
  });

  it("opens an alert right away on a reported failure", async () => {
    vi.stubEnv("HEARTBEAT_TOKEN", "secret");
    await post({ job: "backup", ok: false, message: "upload failed (exit 22)" });
    expect(activeAlerts()).toMatchObject([{ key: "heartbeat:backup", detail: "upload failed (exit 22)" }]);
  });
});
