import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { recordRun } from "@/lib/jobs";
import { checkHeartbeats, HEARTBEATS } from "@/lib/monitor";

const Body = z.object({
  job: z.enum(HEARTBEATS.map((h) => h.job) as [string, ...string[]]),
  ok: z.boolean(),
  message: z.string().max(500).optional(),
});

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/**
 * Outcome reports from the VM's timers (infra/backup/backup.sh, restore-check.sh), which call the app on
 * 127.0.0.1 directly. Bearer HEARTBEAT_TOKEN instead of a session; the edge Caddy refuses this path from outside.
 */
export async function POST(request: Request) {
  const token = process.env.HEARTBEAT_TOKEN;
  if (!token) return Response.json({ error: "not found" }, { status: 404 });
  const auth = request.headers.get("authorization") ?? "";
  if (!timingSafeEqual(sha256(auth), sha256(`Bearer ${token}`))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "bad request" }, { status: 400 });
  const { job, ok, message } = body.data;
  recordRun(job, ok ? null : message || "failed");
  // Alert on a failure now rather than at the next 5-minute check.
  await checkHeartbeats();
  return Response.json({ ok: true });
}
