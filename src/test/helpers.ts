import { vi } from "vitest";
import { db, type TxType } from "@/lib/db";
import { getAccount, saveInstrument } from "@/lib/ledger";
import { accountByName, addTransaction, saveCashAccount, type TxInput } from "@/lib/transactions";

/** Empty every table, keeping the schema. */
export function resetDb() {
  const conn = db();
  const tables = conn
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  conn.transaction(() => tables.forEach((t) => conn.exec(`DELETE FROM ${t.name}`)))();
}

/** Insert a row; returns its rowid. */
export function insert(table: string, row: Record<string, unknown>): number {
  const cols = Object.keys(row);
  const r = db()
    .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`)
    .run(row);
  return Number(r.lastInsertRowid);
}

export function setPrice(key: string, price: number, opts: { changePct?: number | null; fetchedAt?: Date; source?: string } = {}) {
  db()
    .prepare(
      `INSERT INTO prices (key, price, change_pct, source, as_of, fetched_at) VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET price = excluded.price, change_pct = excluded.change_pct, fetched_at = excluded.fetched_at`,
    )
    .run(key, price, opts.changePct ?? null, opts.source ?? "test", (opts.fetchedAt ?? new Date()).toISOString());
}

type Route = readonly [string | RegExp, (url: URL, init?: RequestInit) => Response | Promise<Response>];

/**
 * Replace global fetch: the first route whose pattern matches the URL answers; anything else throws,
 * so a test never reaches the network. Returns the recorded calls.
 */
export function mockFetch(routes: readonly Route[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const route = routes.find(([p]) => (typeof p === "string" ? url.includes(p) : p.test(url)));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return route[1](new URL(url), init);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

/** Telegram that accepts every message; returns the sent payloads. */
export function mockTelegram(ok = true) {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:test");
  vi.stubEnv("TELEGRAM_CHAT_ID", "42");
  const calls = mockFetch([
    ["api.telegram.org", () => (ok ? Response.json({ ok: true }) : new Response("boom", { status: 500 }))],
  ]);
  return {
    calls,
    texts: () => calls.map((c) => (c.body as { text: string }).text),
  };
}

/** A Date at the given Taipei wall-clock time, e.g. at("2026-10-26 09:30"). */
export const at = (taipei: string) => new Date(`${taipei.replace(" ", "T")}:00+08:00`);

/** A cash account with this balance, written the way the cash form does. Returns the ledger account id. */
export function cashAccount(name: string, balance: number, currency = "TWD"): number {
  saveCashAccount({ id: null, name, institution: null, currency, balance, note: null });
  return (db().prepare("SELECT id FROM accounts WHERE kind = 'cash' ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
}

/**
 * A stock or coin position held as of `date`, recorded as an opening balance at `price` per unit
 * (null = unknown cost). Returns the ledger account id.
 */
export function holding(
  asset: string,
  quantity: number,
  price: number | null,
  opts: { account?: string; symbol?: string; name?: string; date?: string } = {},
): number {
  const kind = asset.startsWith("tw:") ? "stock" : "crypto";
  const symbol = opts.symbol ?? asset.slice(asset.indexOf(":") + 1).toUpperCase();
  saveInstrument(asset, symbol, opts.name ?? null);
  const account = accountByName(kind, opts.account ?? (kind === "stock" ? "國泰" : "冷錢包"));
  addTransaction({ ...tx("open", account.id, asset, quantity, price), date: opts.date ?? "2026-01-02" });
  return account.id;
}

/** A transaction input with zero fees and the cash leg a trade of this size implies. */
export function tx(type: TxType, accountId: number, asset: string | null, quantity: number, price: number | null = null, date = "2026-01-02"): TxInput {
  const value = price == null ? 0 : Math.abs(quantity) * price;
  const amount = type === "buy" ? -value : type === "sell" ? value : 0;
  if (!getAccount(accountId)) throw new Error(`no account ${accountId}`);
  return { accountId, date, type, asset, quantity, price, amount, fee: 0, tax: 0, note: null };
}
