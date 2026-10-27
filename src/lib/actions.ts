"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { clientIp, requireAuth } from "./auth";
import {
  checkLoginAllowed,
  clearLoginFailures,
  createSession,
  deleteAllSessions,
  deleteSession,
  recordLoginFailure,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyPassword,
} from "./session";
import { db } from "./db";
import { tracked } from "./jobs";
import { lookupTwStockName, refreshPrices, resolveCoin } from "./prices";
import { takeSnapshot } from "./snapshot";
import { sendTelegram, telegramConfigured } from "./telegram";
import { sinopacConfigured, syncSinopac } from "./tw-futures";

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

// A field missing from the form (e.g. equity when the source is the SinoPac API) counts as empty, not NaN.
const optNum = z.preprocess(
  (v) =>
    v === undefined ? null : typeof v === "string" ? (v.replace(/,/g, "").trim() === "" ? null : v.replace(/,/g, "").trim()) : v,
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
  wallet_balance: "錢包餘額",
  side: "方向",
  quantity: "數量",
  entry_price: "開倉均價",
  leverage: "槓桿",
  broker: "券商",
  source: "資料來源",
  equity: "權益數",
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

// ---------- futures (USDT-margined) ----------

const FuturesAccountSchema = z.object({
  id,
  name: z.string().trim().min(1, "必填"),
  wallet_balance: num,
  note: text,
});

export async function saveFuturesAccount(_: ActionState, fd: FormData): Promise<ActionState> {
  return guarded(async () => {
    const v = FuturesAccountSchema.parse(fields(fd));
    if (v.id) {
      db()
        .prepare(
          `UPDATE futures_accounts SET name=@name, wallet_balance=@wallet_balance, note=@note,
           updated_at=datetime('now') WHERE id=@id`,
        )
        .run(v);
    } else {
      db().prepare(`INSERT INTO futures_accounts (name, wallet_balance, note) VALUES (@name, @wallet_balance, @note)`).run(v);
    }
    await refreshPrices();
    return done();
  });
}

const FuturesPositionSchema = z.object({
  id,
  account_id: z.coerce.number().int().positive(),
  coin: z.string().trim().min(1, "必填"),
  side: z.enum(["long", "short"], { message: "請選擇多或空" }),
  quantity: num.refine((n) => n > 0, "必須大於 0"),
  entry_price: num.refine((n) => n > 0, "必須大於 0"),
  leverage: optNum.refine((n) => n == null || n >= 1, "槓桿至少 1"),
  note: text,
});

export async function saveFuturesPosition(_: ActionState, fd: FormData): Promise<ActionState> {
  return guarded(async () => {
    const v = FuturesPositionSchema.parse(fields(fd));
    const coin = await resolveCoin(v.coin);
    if (!coin) return { ok: false, error: `CoinGecko 找不到「${v.coin}」，請改輸入 CoinGecko coin id（例如 bitcoin）` };
    const row = { ...v, coin_id: coin.id, symbol: coin.symbol.toUpperCase(), name: coin.name };
    if (v.id) {
      db()
        .prepare(
          `UPDATE futures_positions SET coin_id=@coin_id, symbol=@symbol, name=@name, side=@side, quantity=@quantity,
           entry_price=@entry_price, leverage=@leverage, note=@note, updated_at=datetime('now') WHERE id=@id`,
        )
        .run(row);
    } else {
      db()
        .prepare(
          `INSERT INTO futures_positions (account_id, coin_id, symbol, name, side, quantity, entry_price, leverage, note)
           VALUES (@account_id, @coin_id, @symbol, @name, @side, @quantity, @entry_price, @leverage, @note)`,
        )
        .run(row);
    }
    await refreshPrices();
    return done();
  });
}

// ---------- futures (Taiwan / TAIFEX) ----------

const TwFuturesSchema = z
  .object({
    id,
    name: z.string().trim().min(1, "必填"),
    broker: text,
    source: z.enum(["manual", "sinopac"], { message: "請選擇資料來源" }),
    equity: optNum,
    note: text,
  })
  .refine((v) => v.source === "sinopac" || v.equity != null, { message: "必填", path: ["equity"] });

export async function saveTwFutures(_: ActionState, fd: FormData): Promise<ActionState> {
  return guarded(async () => {
    const v = TwFuturesSchema.parse(fields(fd));
    if (v.source === "sinopac" && !sinopacConfigured()) {
      return { ok: false, error: "伺服器沒有設定永豐 API（SINOPAC_URL），請改用手動輸入" };
    }
    if (v.id) {
      // Switching to manual keeps the last synced equity as the starting value.
      db()
        .prepare(
          `UPDATE tw_futures_accounts SET name=@name, broker=@broker, source=@source,
           equity=CASE WHEN @source = 'manual' THEN @equity ELSE equity END,
           synced_at=CASE WHEN @source = 'manual' THEN NULL ELSE synced_at END,
           sync_error=CASE WHEN @source = 'manual' THEN NULL ELSE sync_error END,
           note=@note, updated_at=datetime('now') WHERE id=@id`,
        )
        .run(v);
    } else {
      db()
        .prepare(
          `INSERT INTO tw_futures_accounts (name, broker, source, equity, note)
           VALUES (@name, @broker, @source, COALESCE(@equity, 0), @note)`,
        )
        .run(v);
    }
    if (v.source === "sinopac") {
      const { error } = await syncSinopac();
      if (error) return { ok: false, error: `已儲存，但同步失敗：${error}` };
    }
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
  futuresAccount: "futures_accounts",
  futuresPosition: "futures_positions",
  twFutures: "tw_futures_accounts",
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
    // Tracked like the scheduled one, so a manual retry clears a "snapshot failed" alert.
    await tracked("snapshot", takeSnapshot);
    return done();
  });
}

// ---------- notifications ----------

export async function sendTestNotification(): Promise<ActionState> {
  return guarded(async () => {
    if (!telegramConfigured()) return { ok: false, error: "尚未設定 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID" };
    const sent = await sendTelegram("✅ Assets 測試訊息：告警會送到這裡。");
    return sent ? { ok: true } : { ok: false, error: "傳送失敗，請看伺服器 log" };
  });
}

// ---------- login ----------

const lockedMessage = (ms: number) => `嘗試次數過多，請 ${Math.ceil(ms / 60_000)} 分鐘後再試`;

export async function login(_: ActionState, fd: FormData): Promise<ActionState> {
  const ip = await clientIp();
  const gate = checkLoginAllowed(ip);
  // While locked, even the right password is refused — otherwise the lock would be pointless.
  if (!gate.allowed) return { ok: false, error: lockedMessage(gate.retryAfterMs) };

  if (!verifyPassword(String(fd.get("password") ?? ""))) {
    await new Promise((r) => setTimeout(r, 600));
    const after = recordLoginFailure(ip);
    return { ok: false, error: after.allowed ? "密碼錯誤" : lockedMessage(after.retryAfterMs) };
  }

  clearLoginFailures(ip);
  const token = createSession({ ip, userAgent: (await headers()).get("user-agent") });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  redirect("/");
}

export async function logout() {
  const jar = await cookies();
  deleteSession(jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}

/** Revoke every session, including this one. */
export async function logoutAll() {
  await requireAuth();
  deleteAllSessions();
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
