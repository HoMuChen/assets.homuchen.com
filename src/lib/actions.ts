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
import { CsvError, decodeCsv } from "./broker-csv";
import { bybitConfigured, forgetCursor, syncBybit } from "./bybit";
import { db, type FuturesAccount, type TxType } from "./db";
import { twTradeCosts } from "./fees";
import { importHoldings, importTrades, previewImport, type ImportPreview, type ImportResult } from "./import";
import { acceptItem, clearSource, dismissItem } from "./inbox";
import { tracked } from "./jobs";
import { getAccount, getTransaction, saveInstrument } from "./ledger";
import { LEDGER_TRIAL_DAYS, ledgerTrial } from "./monitor";
import { lookupTwStockName, refreshPrices, resolveCoin } from "./prices";
import { setSetting } from "./settings";
import { takeSnapshot } from "./snapshot";
import { sendTelegram, telegramConfigured } from "./telegram";
import { taipeiDate } from "./time";
import {
  accountByName,
  addTransaction,
  deleteAccount,
  deleteTransaction,
  LedgerError,
  saveCashAccount,
  updateAccount,
  updateTransaction,
} from "./transactions";
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
  symbol: "代號",
  account: "帳戶",
  type: "類型",
  date: "日期",
  price: "價格",
  gross: "現金股利",
  fee: "手續費",
  tax: "稅",
  fee_discount: "手續費折扣",
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
  amount: "金額",
  counterpart: "對方帳戶",
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
    if (e instanceof LedgerError) return { ok: false, error: e.message };
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

/** Create or edit a cash account; `id` is the ledger account. A changed balance is logged as an adjustment. */
export async function saveCash(_: ActionState, fd: FormData): Promise<ActionState> {
  return guarded(async () => {
    const v = CashSchema.parse(fields(fd));
    saveCashAccount(v);
    if (v.currency !== "TWD") await refreshPrices();
    return done();
  });
}

// ---------- stock & crypto transactions ----------

const TxSchema = z.object({
  id,
  kind: z.enum(["stock", "crypto"]),
  account: z.string().trim().min(1, "必填"),
  type: z.enum(["open", "buy", "sell", "dividend", "adjust"], { message: "請選擇類型" }),
  symbol: z.string().trim().min(1, "必填"),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式 YYYY-MM-DD"),
  quantity: optNum,
  price: optNum,
  gross: optNum,
  fee: optNum,
  tax: optNum,
  note: text,
});

const invalid = (field: string, message: string) => new LedgerError(`${FIELD_LABEL[field] ?? field}：${message}`);

/** The quantity, price and cash leg of a form entry; fee and tax default to what a TW broker charges. */
function txAmounts(v: z.infer<typeof TxSchema>, symbol: string, feeDiscount: number | null) {
  const q = v.quantity;
  switch (v.type) {
    case "buy":
    case "sell": {
      if (q == null || !(q > 0)) throw invalid("quantity", "必須大於 0");
      if (v.price == null || !(v.price > 0)) throw invalid("price", "必須大於 0");
      const auto =
        v.kind === "stock"
          ? twTradeCosts({ side: v.type, symbol, shares: q, price: v.price, date: v.date, feeDiscount })
          : { fee: 0, tax: 0 };
      const fee = v.fee ?? auto.fee;
      const tax = v.tax ?? auto.tax;
      const value = q * v.price;
      return v.type === "buy"
        ? { quantity: q, price: v.price, amount: -(value + fee + tax), fee, tax }
        : { quantity: -q, price: v.price, amount: value - fee - tax, fee, tax };
    }
    case "dividend": {
      if (v.kind !== "stock") throw new LedgerError("加密貨幣沒有股利");
      const gross = v.gross ?? 0;
      const shares = q ?? 0;
      if (gross < 0) throw invalid("gross", "不能是負數");
      if (shares < 0) throw invalid("quantity", "不能是負數");
      if (!(gross > 0 || shares > 0)) throw invalid("gross", "現金股利或配股至少填一項");
      const fee = v.fee ?? 0;
      const tax = v.tax ?? 0;
      return { quantity: shares, price: null, amount: gross - fee - tax, fee, tax };
    }
    case "adjust":
      if (!q) throw invalid("quantity", "請填增減的數量，不能是 0");
      return { quantity: q, price: null, amount: 0, fee: 0, tax: 0 };
    case "open":
      if (q == null || q < 0) throw invalid("quantity", "不能是負數");
      if (v.price != null && v.price < 0) throw invalid("price", "不能是負數");
      return { quantity: q, price: v.price, amount: 0, fee: 0, tax: 0 };
  }
}

/** Record or edit one stock / coin transaction. The account is picked by name, and created if new. */
export async function saveTransaction(_: ActionState, fd: FormData): Promise<ActionState> {
  return guarded(async () => {
    const v = TxSchema.parse(fields(fd));
    if (v.type === "open" && (!v.id || getTransaction(v.id)?.type !== "open")) throw new LedgerError("期初只能修改，不能新增");
    let asset: string;
    let symbol: string;
    if (v.kind === "stock") {
      symbol = v.symbol.toUpperCase();
      if (!/^[0-9A-Z]{4,6}$/.test(symbol)) throw invalid("symbol", "台股代號，如 2330 / 00878");
      asset = `tw:${symbol}`;
      saveInstrument(asset, symbol, await lookupTwStockName(symbol));
    } else {
      const coin = await resolveCoin(v.symbol);
      if (!coin) return { ok: false, error: `CoinGecko 找不到「${v.symbol}」，請改輸入 CoinGecko coin id（例如 bitcoin）` };
      asset = `crypto:${coin.id}`;
      symbol = coin.symbol.toUpperCase();
      saveInstrument(asset, symbol, coin.name);
    }
    const account = accountByName(v.kind, v.account);
    const input = { accountId: account.id, date: v.date, type: v.type, asset, note: v.note, ...txAmounts(v, symbol, account.fee_discount) };
    if (v.id) updateTransaction(v.id, input);
    else addTransaction(input);
    await refreshPrices();
    return done();
  });
}

const AccountSchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1, "必填"),
  institution: text,
  // Entered the way brokers quote it: 2.8 折 is 2.8, i.e. 28% of the list rate.
  fee_discount: optNum.refine((n) => n == null || (n > 0 && n <= 10), "填 0–10 的折數，例如 2.8"),
  // Only crypto accounts can sync; other forms don't send it.
  source: z.enum(["manual", "bybit"]).optional(),
  note: text,
});

export async function saveAccount(_: ActionState, fd: FormData): Promise<ActionState> {
  return guarded(async () => {
    const v = AccountSchema.parse(fields(fd));
    const account = getAccount(v.id);
    if (!account) return { ok: false, error: "找不到這個帳戶" };
    const source = account.kind === "crypto" ? (v.source ?? account.source) : account.source;
    if (source === "bybit" && account.source !== "bybit") {
      if (!bybitConfigured()) return { ok: false, error: "伺服器沒有設定 Bybit API（BYBIT_API_KEY、BYBIT_API_SECRET）" };
      if (db().prepare("SELECT 1 FROM accounts WHERE kind = 'crypto' AND source = 'bybit' AND id != ?").get(v.id)) {
        return { ok: false, error: "已經有另一個帳戶連結 Bybit 了" };
      }
    }
    updateAccount(v.id, { name: v.name, institution: v.institution, feeDiscount: v.fee_discount == null ? null : v.fee_discount / 10, note: v.note, source });
    if (account.source === "bybit" && source !== "bybit") {
      // Linking again later starts over from that day's balances.
      clearSource(v.id, "bybit");
      forgetCursor(`spot:${v.id}`);
    }
    if (source === "bybit" && account.source !== "bybit") {
      const { error } = await syncBybit("full");
      if (error) return { ok: false, error: `已儲存，但同步失敗：${error}` };
    }
    return done();
  });
}

/** Make the ledger, or again the old tables, the source of every page's holdings. */
export async function setLedgerMode(mode: "shadow" | "primary"): Promise<ActionState> {
  return guarded(() => {
    if (mode === "primary" && !ledgerTrial().ready) {
      return { ok: false, error: `帳本要先和舊資料連續一致 ${LEDGER_TRIAL_DAYS} 天才能切換` };
    }
    setSetting("ledger_mode", mode === "primary" ? "primary" : "shadow");
    return done();
  });
}

// ---------- futures (USDT-margined) ----------

const FuturesAccountSchema = z
  .object({
    id,
    name: z.string().trim().min(1, "必填"),
    source: z.enum(["manual", "bybit"]).default("manual"),
    wallet_balance: optNum,
    note: text,
  })
  .refine((v) => v.source === "bybit" || v.wallet_balance != null, { message: "必填", path: ["wallet_balance"] });

export async function saveFuturesAccount(_: ActionState, fd: FormData): Promise<ActionState> {
  return guarded(async () => {
    const v = FuturesAccountSchema.parse(fields(fd));
    if (v.source === "bybit") {
      if (!bybitConfigured()) return { ok: false, error: "伺服器沒有設定 Bybit API（BYBIT_API_KEY、BYBIT_API_SECRET），請改用手動輸入" };
      if (db().prepare("SELECT 1 FROM futures_accounts WHERE source = 'bybit' AND id IS NOT ?").get(v.id)) {
        return { ok: false, error: "已經有另一個合約帳戶連結 Bybit 了" };
      }
    }
    const prev = v.id ? (db().prepare("SELECT * FROM futures_accounts WHERE id = ?").get(v.id) as FuturesAccount | undefined) : undefined;
    db().transaction(() => {
      if (prev) {
        // Switching to manual keeps the last synced numbers as the starting point.
        db()
          .prepare(
            `UPDATE futures_accounts SET name=@name, source=@source, note=@note,
             wallet_balance=CASE WHEN @source = 'manual' THEN @wallet_balance ELSE wallet_balance END,
             sync_error=CASE WHEN @source = 'manual' THEN NULL ELSE sync_error END,
             updated_at=datetime('now') WHERE id=@id`,
          )
          .run(v);
        // Manual positions are priced from CoinGecko again.
        if (prev.source === "bybit" && v.source === "manual") {
          db().prepare("UPDATE futures_positions SET mark_price = NULL, liq_price = NULL, upnl = NULL WHERE account_id = ?").run(v.id);
          if (prev.account_id) clearSource(prev.account_id, "bybit");
        }
        if (prev.account_id) db().prepare("UPDATE accounts SET name = ? WHERE id = ?").run(v.name, prev.account_id);
      } else {
        db()
          .prepare(`INSERT INTO futures_accounts (name, source, wallet_balance, note) VALUES (@name, @source, COALESCE(@wallet_balance, 0), @note)`)
          .run(v);
      }
    })();
    if (v.source === "bybit") {
      const { error } = await syncBybit("full");
      if (error) return { ok: false, error: `已儲存，但同步失敗：${error}` };
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
  property: "properties",
  futuresAccount: "futures_accounts",
  futuresPosition: "futures_positions",
  twFutures: "tw_futures_accounts",
} as const;

export type DeleteKind = keyof typeof TABLES | "account" | "transaction";

export async function deleteItem(kind: DeleteKind, itemId: number): Promise<ActionState> {
  return guarded(() => {
    if (kind === "account") deleteAccount(itemId);
    else if (kind === "transaction") deleteTransaction(itemId);
    if (kind === "account" || kind === "transaction") return done();
    const table = Object.hasOwn(TABLES, kind) ? TABLES[kind] : undefined;
    if (!table) return { ok: false, error: "unknown kind" };
    // A synced futures account takes its ledger history with it.
    const ledgerId =
      kind === "futuresAccount" ? (db().prepare("SELECT account_id FROM futures_accounts WHERE id = ?").get(itemId) as { account_id: number | null } | undefined)?.account_id : null;
    db().prepare(`DELETE FROM ${table} WHERE id = ?`).run(itemId);
    if (ledgerId) deleteAccount(ledgerId);
    return done();
  });
}

// ---------- refresh / snapshot ----------

export async function refreshNow(): Promise<ActionState> {
  return guarded(async () => {
    const [r, bybit] = await Promise.all([refreshPrices({ force: true }), syncBybit("balances")]);
    revalidatePath("/", "layout");
    const errors = [...r.errors, ...(bybit.error ? [bybit.error] : [])];
    return errors.length ? { ok: false, error: errors.join("；") } : { ok: true };
  });
}

// ---------- reconciliation inbox ----------

const AcceptSchema = z.object({
  id: z.coerce.number().int().positive(),
  type: z.string().trim().min(1, "請選擇類型"),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式 YYYY-MM-DD"),
  quantity: optNum,
  price: optNum,
  amount: optNum,
  counterpart: id,
  note: text,
});

/** Confirm an inbox item as a transaction, as edited in its dialog. */
export async function acceptInbox(_: ActionState, fd: FormData): Promise<ActionState> {
  return guarded(() => {
    const v = AcceptSchema.parse(fields(fd));
    if (v.price != null && v.price < 0) throw invalid("price", "不能是負數");
    acceptItem(v.id, {
      type: v.type as TxType,
      date: v.date,
      quantity: v.quantity ?? 0,
      price: v.price,
      amount: v.amount ?? 0,
      note: v.note,
      counterpartId: v.counterpart,
    });
    return done();
  });
}

export async function dismissInbox(itemId: number): Promise<ActionState> {
  return guarded(() => {
    dismissItem(itemId);
    return done();
  });
}

// ---------- broker CSV import ----------

/** Files from a broker are a few hundred KB at most; Server Actions take 1 MB. */
const MAX_IMPORT_BYTES = 900_000;

async function importFile(fd: FormData) {
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) throw new LedgerError("請選擇檔案");
  if (file.size > MAX_IMPORT_BYTES) throw new LedgerError("檔案太大（上限 900 KB），請只匯出需要的期間");
  const account = String(fd.get("account") ?? "").trim();
  if (!account) throw invalid("account", "必填");
  const date = String(fd.get("date") ?? "") || taipeiDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid("date", "日期格式 YYYY-MM-DD");
  return { text: decodeCsv(new Uint8Array(await file.arrayBuffer())), account, date };
}

export type PreviewState = { ok: true; preview: ImportPreview } | { ok: false; error: string };
export type ImportState = { ok: true; result: ImportResult } | { ok: false; error: string };

const importError = (e: unknown) => {
  if (e instanceof CsvError || e instanceof LedgerError) return e.message;
  console.error(e);
  return (e as Error).message;
};

/** Read a broker CSV against a stock account without writing anything. */
export async function previewBrokerCsv(fd: FormData): Promise<PreviewState> {
  await requireAuth();
  try {
    const f = await importFile(fd);
    return { ok: true, preview: previewImport(f.text, f.account, f.date) };
  } catch (e) {
    return { ok: false, error: importError(e) };
  }
}

/** Write what the preview showed: the chosen trade rows (`line`), or a holdings statement into the inbox. */
export async function importBrokerCsv(fd: FormData): Promise<ImportState> {
  await requireAuth();
  try {
    const f = await importFile(fd);
    const lines = fd.getAll("line").map(Number).filter(Number.isInteger);
    const result =
      fd.get("kind") === "holdings"
        ? importHoldings(f.text, f.account, f.date)
        : await importTrades(f.text, f.account, new Set(lines), lookupTwStockName);
    revalidatePath("/", "layout");
    if (result.added) await refreshPrices();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: importError(e) };
  }
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
