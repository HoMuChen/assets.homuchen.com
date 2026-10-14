"use server";

import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth, SESSION_COOKIE, sessionToken } from "./auth";
import { db } from "./db";
import { lookupTwStockName, refreshPrices, resolveCoin } from "./prices";
import { takeSnapshot } from "./snapshot";

export type ActionState = { ok: boolean; error?: string } | null;

// ---------- form parsing helpers ----------

const text = z
  .string()
  .trim()
  .transform((s) => (s === "" ? null : s))
  .nullable()
  .optional()
  .transform((s) => s ?? null);

const num = z.preprocess(
  (v) => (typeof v === "string" ? v.replace(/,/g, "").trim() : v),
  z.coerce.number({ message: "請輸入數字" }).refine(Number.isFinite, "請輸入數字"),
);

const optNum = z.preprocess(
  (v) => (typeof v === "string" ? (v.replace(/,/g, "").trim() === "" ? null : v.replace(/,/g, "").trim()) : v),
  z.coerce.number({ message: "請輸入數字" }).nullable(),
);

const id = z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().int().positive().nullable());

function fields(fd: FormData) {
  return Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string"));
}

const FIELD_LABEL: Record<string, string> = {
  name: "名稱",
  currency: "幣別",
  balance: "餘額",
  symbol: "股票代號",
  shares: "股數",
  avg_cost: "平均成本",
  coin: "幣種",
  amount: "數量",
  avg_cost_twd: "平均成本",
  cash_invested: "投入現金",
  estimated_value: "估計市值",
  loan_amount: "貸款金額",
  annual_rate: "年利率",
  term_years: "貸款年限",
  grace_months: "寬限期",
  loan_start_date: "撥款日",
  balance_override: "剩餘本金",
};

function firstError(e: z.ZodError): string {
  const issue = e.issues[0];
  const field = String(issue.path[0] ?? "");
  return `${FIELD_LABEL[field] ?? field}：${issue.message}`;
}

function done() {
  revalidatePath("/", "layout");
  return { ok: true } as const;
}

async function guarded(fn: () => Promise<ActionState> | ActionState): Promise<ActionState> {
  await requireAuth();
  try {
    return await fn();
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: firstError(e) };
    console.error(e);
    return { ok: false, error: (e as Error).message };
  }
}

// ---------- cash ----------

const CashSchema = z.object({
  id,
  name: z.string().trim().min(1, "必填"),
  institution: text,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "三碼幣別，如 TWD / USD"),
  balance: num,
  note: text,
});

export async function saveCash(_: ActionState, fd: FormData): Promise<ActionState> {
  return guarded(async () => {
    const v = CashSchema.parse(fields(fd));
    if (v.id) {
      db()
        .prepare(
          `UPDATE cash_accounts SET name=@name, institution=@institution, currency=@currency, balance=@balance,
           note=@note, updated_at=datetime('now') WHERE id=@id`,
        )
        .run(v);
    } else {
      db()
        .prepare(
          `INSERT INTO cash_accounts (name, institution, currency, balance, note)
           VALUES (@name, @institution, @currency, @balance, @note)`,
        )
        .run(v);
    }
    if (v.currency !== "TWD") await refreshPrices();
    return done();
  });
}

// ---------- stocks ----------

const StockSchema = z.object({
  id,
  symbol: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{4,6}$/, "台股代號，如 2330 / 00878"),
  shares: num,
  avg_cost: optNum,
  broker: text,
  note: text,
});

export async function saveStock(_: ActionState, fd: FormData): Promise<ActionState> {
  return guarded(async () => {
    const v = StockSchema.parse(fields(fd));
    const name = await lookupTwStockName(v.symbol);
    const row = { ...v, name };
    if (v.id) {
      db()
        .prepare(
          `UPDATE stock_holdings SET symbol=@symbol, name=COALESCE(@name, name), shares=@shares, avg_cost=@avg_cost,
           broker=@broker, note=@note, updated_at=datetime('now') WHERE id=@id`,
        )
        .run(row);
    } else {
      db()
        .prepare(
          `INSERT INTO stock_holdings (symbol, name, shares, avg_cost, broker, note)
           VALUES (@symbol, @name, @shares, @avg_cost, @broker, @note)`,
        )
        .run(row);
    }
    await refreshPrices();
    return done();
  });
}

// ---------- crypto ----------

const CryptoSchema = z.object({
  id,
  coin: z.string().trim().min(1, "必填"),
  amount: num,
  avg_cost_twd: optNum,
  location: text,
  note: text,
});

export async function saveCrypto(_: ActionState, fd: FormData): Promise<ActionState> {
  return guarded(async () => {
    const v = CryptoSchema.parse(fields(fd));
    const coin = await resolveCoin(v.coin);
    if (!coin) return { ok: false, error: `CoinGecko 找不到「${v.coin}」，請改輸入 CoinGecko coin id（例如 bitcoin）` };
    const row = { ...v, coin_id: coin.id, symbol: coin.symbol.toUpperCase(), name: coin.name };
    if (v.id) {
      db()
        .prepare(
          `UPDATE crypto_holdings SET coin_id=@coin_id, symbol=@symbol, name=@name, amount=@amount,
           avg_cost_twd=@avg_cost_twd, location=@location, note=@note, updated_at=datetime('now') WHERE id=@id`,
        )
        .run(row);
    } else {
      db()
        .prepare(
          `INSERT INTO crypto_holdings (coin_id, symbol, name, amount, avg_cost_twd, location, note)
           VALUES (@coin_id, @symbol, @name, @amount, @avg_cost_twd, @location, @note)`,
        )
        .run(row);
    }
    await refreshPrices();
    return done();
  });
}

// ---------- real estate ----------

const PropertySchema = z.object({
  id,
  name: z.string().trim().min(1, "必填"),
  cash_invested: num,
  estimated_value: optNum,
  loan_amount: num,
  annual_rate: num,
  term_years: num,
  grace_months: optNum,
  loan_start_date: text.refine((s) => s == null || /^\d{4}-\d{2}-\d{2}$/.test(s), "日期格式 YYYY-MM-DD"),
  balance_override: optNum,
  note: text,
});

export async function saveProperty(_: ActionState, fd: FormData): Promise<ActionState> {
  return guarded(() => {
    const { term_years, ...v } = PropertySchema.parse(fields(fd));
    const row = { ...v, term_months: Math.round(term_years * 12), grace_months: v.grace_months ?? 0 };
    if (v.id) {
      db()
        .prepare(
          `UPDATE properties SET name=@name, cash_invested=@cash_invested, estimated_value=@estimated_value,
           loan_amount=@loan_amount, annual_rate=@annual_rate, term_months=@term_months, grace_months=@grace_months,
           loan_start_date=@loan_start_date, balance_override=@balance_override, note=@note,
           updated_at=datetime('now') WHERE id=@id`,
        )
        .run(row);
    } else {
      db()
        .prepare(
          `INSERT INTO properties (name, cash_invested, estimated_value, loan_amount, annual_rate, term_months,
           grace_months, loan_start_date, balance_override, note)
           VALUES (@name, @cash_invested, @estimated_value, @loan_amount, @annual_rate, @term_months,
           @grace_months, @loan_start_date, @balance_override, @note)`,
        )
        .run(row);
    }
    return done();
  });
}

// ---------- delete ----------

const TABLES = {
  cash: "cash_accounts",
  stock: "stock_holdings",
  crypto: "crypto_holdings",
  property: "properties",
} as const;

export async function deleteItem(kind: keyof typeof TABLES, itemId: number): Promise<ActionState> {
  return guarded(() => {
    const table = TABLES[kind];
    if (!table) return { ok: false, error: "unknown kind" };
    db().prepare(`DELETE FROM ${table} WHERE id = ?`).run(itemId);
    return done();
  });
}

// ---------- refresh / snapshot ----------

export async function refreshNow(): Promise<ActionState> {
  return guarded(async () => {
    const r = await refreshPrices({ force: true });
    revalidatePath("/", "layout");
    return r.errors.length ? { ok: false, error: r.errors.join("；") } : { ok: true };
  });
}

export async function snapshotNow(): Promise<ActionState> {
  return guarded(async () => {
    await takeSnapshot();
    return done();
  });
}

// ---------- login ----------

export async function login(_: ActionState, fd: FormData): Promise<ActionState> {
  const password = String(fd.get("password") ?? "");
  const expected = process.env.APP_PASSWORD;
  const a = Buffer.from(password);
  const b = Buffer.from(expected ?? "");
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    await new Promise((r) => setTimeout(r, 600));
    return { ok: false, error: "密碼錯誤" };
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await sessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect("/");
}

export async function logout() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
