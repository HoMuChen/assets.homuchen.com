import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Public liveness probe; deploy.sh and the Deploy workflow compare `version` with the image's GIT_SHA. */
export function GET() {
  let dbStatus = "ok";
  try {
    db().prepare("SELECT 1").get();
  } catch {
    dbStatus = "error";
  }
  return Response.json(
    { status: dbStatus === "ok" ? "ok" : "degraded", db: dbStatus, version: process.env.GIT_SHA ?? "dev" },
    { status: dbStatus === "ok" ? 200 : 503 },
  );
}
