import { unauthorizedResponse } from "@/lib/auth";
import { takeSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

export async function POST() {
  const denied = await unauthorizedResponse();
  if (denied) return denied;
  const row = await takeSnapshot();
  return Response.json({ date: row.date, netWorth: row.net_worth });
}
