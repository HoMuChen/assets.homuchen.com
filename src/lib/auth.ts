import { cookies } from "next/headers";

export const SESSION_COOKIE = "assets_session";

/** Auth is enabled only when APP_PASSWORD is set (leave it unset for a LAN-only instance). */
export const authEnabled = () => !!process.env.APP_PASSWORD;

/** Session token = HMAC(APP_PASSWORD, "session"); changing the password logs everyone out. */
export async function sessionToken(): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(process.env.APP_PASSWORD ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("assets-dashboard-session-v1"));
  return Buffer.from(sig).toString("base64url");
}

export async function isValidSession(value: string | undefined): Promise<boolean> {
  if (!authEnabled()) return true;
  return !!value && value === (await sessionToken());
}

/** Call at the top of every Server Function; proxy coverage alone is not enough. */
export async function requireAuth() {
  const jar = await cookies();
  if (!(await isValidSession(jar.get(SESSION_COOKIE)?.value))) throw new Error("Unauthorized");
}
