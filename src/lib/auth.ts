import { cookies, headers } from "next/headers";
import { isValidSession, SESSION_COOKIE } from "./session";

export { authEnabled } from "./session";

/** Call at the top of every Server Function; proxy coverage alone is not enough. */
export async function requireAuth() {
  const jar = await cookies();
  if (!isValidSession(jar.get(SESSION_COOKIE)?.value)) throw new Error("Unauthorized");
}

/**
 * Client IP as reported by the reverse proxy. These headers are spoofable when the app is
 * exposed directly, which is why the global failure cap exists alongside the per-IP one.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get("cf-connecting-ip") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
