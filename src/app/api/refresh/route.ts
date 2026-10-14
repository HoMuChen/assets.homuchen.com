import { unauthorizedResponse } from "@/lib/auth";
import { refreshPrices } from "@/lib/prices";

export const dynamic = "force-dynamic";

/** Opportunistic refresh: only fetches quotes past their TTL unless ?force=1. */
export async function POST(request: Request) {
  const denied = await unauthorizedResponse();
  if (denied) return denied;
  const force = new URL(request.url).searchParams.get("force") === "1";
  const result = await refreshPrices({ force });
  return Response.json(result);
}
