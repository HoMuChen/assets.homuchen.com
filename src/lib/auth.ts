import { cookies, headers } from "next/headers";
import { isValidSession, SESSION_COOKIE } from "./session";

export { authEnabled } from "./session";

export async function isAuthenticated(): Promise<boolean> {
  const jar = await cookies();
  return isValidSession(jar.get(SESSION_COOKIE)?.value);
}

/** Call at the top of every Server Function; proxy coverage alone is not enough. */
export async function requireAuth() {
  if (!(await isAuthenticated())) throw new Error("Unauthorized");
}

/** Route Handler counterpart of requireAuth: a 401 response to return, or null when signed in. */
export async function unauthorizedResponse(): Promise<Response | null> {
  return (await isAuthenticated()) ? null : Response.json({ error: "unauthorized" }, { status: 401 });
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
