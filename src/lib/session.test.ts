import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "@/test/helpers";
import { db } from "./db";
import {
  checkLoginAllowed,
  clearLoginFailures,
  createSession,
  deleteAllSessions,
  deleteSession,
  isValidSession,
  pruneAuthTables,
  recordLoginFailure,
  SESSION_TTL_MS,
  verifyPassword,
} from "./session";

beforeEach(() => {
  resetDb();
  vi.stubEnv("APP_PASSWORD", "correct horse");
});

const meta = { ip: "1.2.3.4", userAgent: "test" };

describe("password", () => {
  it("accepts only the exact password, and nothing when auth is off", () => {
    expect(verifyPassword("correct horse")).toBe(true);
    expect(verifyPassword("correct hors")).toBe(false);
    expect(verifyPassword("")).toBe(false);
    vi.stubEnv("APP_PASSWORD", "");
    expect(verifyPassword("")).toBe(false);
  });
});

describe("sessions", () => {
  it("stores only a hash of the token", () => {
    const token = createSession(meta);
    expect(isValidSession(token)).toBe(true);
    const stored = db().prepare("SELECT token_hash FROM sessions").all() as { token_hash: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).not.toBe(token);
  });

  it("rejects unknown, missing, expired and logged-out tokens", () => {
    expect(isValidSession(undefined)).toBe(false);
    expect(isValidSession("forged")).toBe(false);

    const expired = createSession(meta);
    db().prepare("UPDATE sessions SET expires_at = ?").run(Date.now() - 1);
    expect(isValidSession(expired)).toBe(false);

    const t = createSession(meta);
    deleteSession(t);
    expect(isValidSession(t)).toBe(false);
  });

  it("invalidates every session when APP_PASSWORD changes", () => {
    const t = createSession(meta);
    vi.stubEnv("APP_PASSWORD", "new password");
    expect(isValidSession(t)).toBe(false);
  });

  it("logs out every device at once", () => {
    const a = createSession(meta);
    const b = createSession(meta);
    deleteAllSessions();
    expect([isValidSession(a), isValidSession(b)]).toEqual([false, false]);
  });

  it("lets everyone in when auth is disabled", () => {
    vi.stubEnv("APP_PASSWORD", "");
    expect(isValidSession(undefined)).toBe(true);
  });

  it("expires after 30 days", () => {
    createSession(meta);
    const { created_at, expires_at } = db().prepare("SELECT created_at, expires_at FROM sessions").get() as {
      created_at: number;
      expires_at: number;
    };
    expect(expires_at - created_at).toBe(SESSION_TTL_MS);
  });
});

describe("brute-force protection", () => {
  it("locks an IP after 5 failures within 15 minutes, without affecting other IPs", () => {
    for (let i = 0; i < 4; i++) expect(recordLoginFailure("6.6.6.6").allowed).toBe(true);
    expect(recordLoginFailure("6.6.6.6")).toEqual({ allowed: false, retryAfterMs: 15 * 60_000 });
    expect(checkLoginAllowed("6.6.6.6").allowed).toBe(false);
    expect(checkLoginAllowed("7.7.7.7").allowed).toBe(true);
  });

  it("locks every login after 20 failures across IPs", () => {
    for (let i = 0; i < 19; i++) expect(recordLoginFailure(`10.0.0.${i}`).allowed).toBe(true);
    expect(recordLoginFailure("10.0.0.99").allowed).toBe(false);
    expect(checkLoginAllowed("192.168.1.1").allowed).toBe(false);
  });

  it("forgets an IP's failures after a successful login", () => {
    for (let i = 0; i < 4; i++) recordLoginFailure("6.6.6.6");
    clearLoginFailures("6.6.6.6");
    expect(recordLoginFailure("6.6.6.6").allowed).toBe(true);
  });

  it("prunes expired sessions, old failures and finished locks", () => {
    createSession(meta);
    db().prepare("UPDATE sessions SET expires_at = 0").run();
    db().prepare("INSERT INTO login_failures (ip, at) VALUES ('x', 0)").run();
    db().prepare("INSERT INTO login_locks (scope, until) VALUES ('ip:x', 0)").run();
    pruneAuthTables();
    for (const t of ["sessions", "login_failures", "login_locks"]) {
      expect(db().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
  });
});
