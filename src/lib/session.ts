import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db";

// No Next.js imports here: this module is shared by proxy.ts and Server Functions.

export const SESSION_COOKIE = "assets_session";
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;

const FAILURE_WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
/** Failed attempts from one IP within the window before that IP is locked. */
const MAX_FAILURES_PER_IP = 5;
/** Failed attempts from all IPs combined before every login is locked (defeats IP rotation / spoofed headers). */
const MAX_FAILURES_GLOBAL = 20;
const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

/** Auth is enabled only when APP_PASSWORD is set (leave it unset for a LAN-only instance). */
export const authEnabled = () => !!process.env.APP_PASSWORD;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Changes whenever APP_PASSWORD changes, invalidating every existing session. */
function passwordFingerprint(): string {
  return createHmac("sha256", process.env.APP_PASSWORD ?? "").update("assets-session-v2").digest("hex");
}

export function verifyPassword(input: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return false;
  // Compare fixed-length digests so neither content nor length leaks through timing.
  return timingSafeEqual(Buffer.from(sha256(input), "hex"), Buffer.from(sha256(expected), "hex"));
}

// ---------- sessions ----------

export function createSession(meta: { ip: string | null; userAgent: string | null }): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO sessions (token_hash, pw_fingerprint, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sha256(token), passwordFingerprint(), now, now + SESSION_TTL_MS, now, meta.ip, meta.userAgent?.slice(0, 300) ?? null);
  return token;
}

export function isValidSession(token: string | undefined): boolean {
  if (!authEnabled()) return true;
  if (!token) return false;
  const hash = sha256(token);
  const row = db()
    .prepare("SELECT pw_fingerprint, expires_at, last_seen_at FROM sessions WHERE token_hash = ?")
    .get(hash) as { pw_fingerprint: string; expires_at: number; last_seen_at: number } | undefined;
  const now = Date.now();
  if (!row || row.expires_at <= now || row.pw_fingerprint !== passwordFingerprint()) return false;
  if (now - row.last_seen_at > LAST_SEEN_THROTTLE_MS) {
    db().prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, hash);
  }
  return true;
}

export function deleteSession(token: string | undefined) {
  if (token) db().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function deleteAllSessions() {
  db().prepare("DELETE FROM sessions").run();
}

// ---------- brute-force protection ----------

export type LoginGate = { allowed: true } | { allowed: false; retryAfterMs: number };

export function checkLoginAllowed(ip: string): LoginGate {
  const now = Date.now();
  const lock = db()
    .prepare("SELECT MAX(until) AS until FROM login_locks WHERE scope IN (?, 'global') AND until > ?")
    .get(`ip:${ip}`, now) as { until: number | null };
  return lock.until ? { allowed: false, retryAfterMs: lock.until - now } : { allowed: true };
}

/** Records a failed attempt; returns the lock now in effect, if this failure triggered one. */
export function recordLoginFailure(ip: string): LoginGate {
  const conn = db();
  const now = Date.now();
  const since = now - FAILURE_WINDOW_MS;
  const lock = conn.prepare(
    "INSERT INTO login_locks (scope, until) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET until = excluded.until",
  );

  return conn.transaction((): LoginGate => {
    conn.prepare("INSERT INTO login_failures (ip, at) VALUES (?, ?)").run(ip, now);

    const ipCount = (conn.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at > ?").get(ip, since) as { n: number }).n;
    if (ipCount >= MAX_FAILURES_PER_IP) {
      lock.run(`ip:${ip}`, now + LOCK_MS);
      conn.prepare("DELETE FROM login_failures WHERE ip = ?").run(ip);
      console.warn(`[auth] locked ${ip} after ${ipCount} failed logins`);
      return { allowed: false, retryAfterMs: LOCK_MS };
    }

    const total = (conn.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE at > ?").get(since) as { n: number }).n;
    if (total >= MAX_FAILURES_GLOBAL) {
      lock.run("global", now + LOCK_MS);
      conn.prepare("DELETE FROM login_failures").run();
      console.warn(`[auth] global login lock after ${total} failed logins`);
      return { allowed: false, retryAfterMs: LOCK_MS };
    }
    return { allowed: true };
  })();
}

export function clearLoginFailures(ip: string) {
  db().prepare("DELETE FROM login_failures WHERE ip = ?").run(ip);
}

/** Drop expired sessions, stale failures, and finished locks. */
export function pruneAuthTables() {
  const now = Date.now();
  const conn = db();
  conn.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  conn.prepare("DELETE FROM login_failures WHERE at <= ?").run(now - FAILURE_WINDOW_MS);
  conn.prepare("DELETE FROM login_locks WHERE until <= ?").run(now);
}
