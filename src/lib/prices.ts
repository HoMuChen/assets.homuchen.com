import { db, type PriceRow } from "./db";
import { isTwMarketOpen, taipeiDate } from "./time";
import { sinopacStale, syncSinopac } from "./tw-futures";

const FINMIND = "https://api.finmindtrade.com/api/v4";
const COINGECKO = "https://api.coingecko.com/api/v3";
export const USDT_COIN_ID = "tether";

// How long a cached quote counts as fresh before an opportunistic refresh re-fetches it.
const TTL_MS = {
  stockOpen: 20_000,
  stockClosed: 30 * 60_000,
  crypto: 60_000,
  fx: 60 * 60_000,
};

type Quote = { key: string; price: number; changePct: number | null; source: string; asOf: string | null };

function finmindHeaders(): HeadersInit {
  const token = process.env.FINMIND_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function coingeckoHeaders(): HeadersInit {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { "x-cg-demo-api-key": key } : {};
}

async function getJson<T>(url: string, headers: HeadersInit = {}): Promise<T> {
  const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return (await res.json()) as T;
}

type FinmindResp<T> = { status: number; msg: string; data?: T[] };

/** Real-time quote (FinMind sponsor tier), ~10s latency. */
async function twSnapshot(symbol: string): Promise<Quote | null> {
  const r = await getJson<FinmindResp<{ close: number; change_rate: number; date: string }>>(
    `${FINMIND}/taiwan_stock_tick_snapshot?data_id=${encodeURIComponent(symbol)}`,
    finmindHeaders(),
  );
  const row = r.status === 200 ? r.data?.[0] : undefined;
  if (!row || !(row.close > 0)) return null;
  return { key: `tw:${symbol}`, price: row.close, changePct: row.change_rate ?? null, source: "finmind:snapshot", asOf: row.date };
}

/** Fallback: latest daily close. */
async function twDailyClose(symbol: string): Promise<Quote | null> {
  const start = taipeiDate(new Date(Date.now() - 14 * 86_400_000));
  const r = await getJson<FinmindResp<{ close: number; spread: number; date: string }>>(
    `${FINMIND}/data?dataset=TaiwanStockPrice&data_id=${encodeURIComponent(symbol)}&start_date=${start}`,
    finmindHeaders(),
  );
  const rows = r.data ?? [];
  const last = rows[rows.length - 1];
  if (!last) return null;
  const prev = last.close - last.spread;
  return {
    key: `tw:${symbol}`,
    price: last.close,
    changePct: prev > 0 ? (last.spread / prev) * 100 : null,
    source: "finmind:daily",
    asOf: last.date,
  };
}

async function fetchTwStock(symbol: string): Promise<Quote | null> {
  try {
    const q = await twSnapshot(symbol);
    if (q) return q;
  } catch (e) {
    console.warn(`[prices] snapshot ${symbol} failed, falling back to daily close:`, (e as Error).message);
  }
  return twDailyClose(symbol);
}

/** Saves both a TWD quote (spot valuation) and a USD quote (futures PnL in USDT). */
async function fetchCrypto(coinIds: string[]): Promise<Quote[]> {
  if (coinIds.length === 0) return [];
  const r = await getJson<
    Record<string, { twd?: number; usd?: number; twd_24h_change?: number; usd_24h_change?: number; last_updated_at?: number }>
  >(
    `${COINGECKO}/simple/price?ids=${coinIds.map(encodeURIComponent).join(",")}&vs_currencies=twd,usd&include_24hr_change=true&include_last_updated_at=true`,
    coingeckoHeaders(),
  );
  return Object.entries(r).flatMap(([id, v]) => {
    const asOf = v.last_updated_at ? new Date(v.last_updated_at * 1000).toISOString() : null;
    const out: Quote[] = [];
    if (typeof v.twd === "number")
      out.push({ key: `crypto:${id}`, price: v.twd, changePct: v.twd_24h_change ?? null, source: "coingecko", asOf });
    if (typeof v.usd === "number")
      out.push({ key: `crypto_usd:${id}`, price: v.usd, changePct: v.usd_24h_change ?? null, source: "coingecko", asOf });
    return out;
  });
}

/** TWD per one unit of each currency. */
async function fetchFx(currencies: string[]): Promise<Quote[]> {
  const wanted = currencies.filter((c) => c !== "TWD");
  if (wanted.length === 0) return [];
  const r = await getJson<{ result: string; rates: Record<string, number>; time_last_update_utc: string }>(
    "https://open.er-api.com/v6/latest/USD",
  );
  const twdPerUsd = r.rates.TWD;
  return wanted
    .filter((c) => r.rates[c])
    .map((c) => ({
      key: `fx:${c}`,
      price: twdPerUsd / r.rates[c],
      changePct: null,
      source: "exchangerate-api",
      asOf: new Date(r.time_last_update_utc).toISOString(),
    }));
}

function saveQuotes(quotes: Quote[]) {
  const stmt = db().prepare(
    `INSERT INTO prices (key, price, change_pct, source, as_of, fetched_at)
     VALUES (@key, @price, @changePct, @source, @asOf, @fetchedAt)
     ON CONFLICT(key) DO UPDATE SET price=excluded.price, change_pct=excluded.change_pct,
       source=excluded.source, as_of=excluded.as_of, fetched_at=excluded.fetched_at`,
  );
  const fetchedAt = new Date().toISOString();
  db().transaction(() => quotes.forEach((q) => stmt.run({ ...q, fetchedAt })))();
}

export function getPriceMap(): Map<string, PriceRow> {
  const rows = db().prepare("SELECT * FROM prices").all() as PriceRow[];
  return new Map(rows.map((r) => [r.key, r]));
}

function isStale(row: PriceRow | undefined, ttl: number): boolean {
  return !row || Date.now() - new Date(row.fetched_at).getTime() > ttl;
}

export type RefreshResult = { updated: number; errors: string[] };

let inFlight: Promise<RefreshResult> | null = null;

/**
 * Refresh quotes for everything currently held. Without `force`, only stale
 * quotes are fetched, so this is cheap to call on every page view.
 */
export function refreshPrices(opts: { force?: boolean } = {}): Promise<RefreshResult> {
  if (!inFlight) {
    inFlight = doRefresh(opts.force ?? false).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function doRefresh(force: boolean): Promise<RefreshResult> {
  const conn = db();
  const cached = getPriceMap();
  const stockTtl = isTwMarketOpen() ? TTL_MS.stockOpen : TTL_MS.stockClosed;

  const symbols = (conn.prepare("SELECT DISTINCT symbol FROM stock_holdings").all() as { symbol: string }[])
    .map((r) => r.symbol)
    .filter((s) => force || isStale(cached.get(`tw:${s}`), stockTtl));
  const hasFutures = !!conn.prepare("SELECT 1 FROM futures_accounts LIMIT 1").get();
  const coinIds = new Set(
    (
      conn
        .prepare("SELECT coin_id FROM crypto_holdings UNION SELECT coin_id FROM futures_positions")
        .all() as { coin_id: string }[]
    ).map((r) => r.coin_id),
  );
  // USDT's TWD price converts futures equity into TWD.
  if (hasFutures) coinIds.add(USDT_COIN_ID);
  const coins = [...coinIds].filter(
    (c) => force || isStale(cached.get(`crypto:${c}`), TTL_MS.crypto) || !cached.has(`crypto_usd:${c}`),
  );
  const currencies = (conn.prepare("SELECT DISTINCT currency FROM cash_accounts").all() as { currency: string }[])
    .map((r) => r.currency)
    .filter((c) => c !== "TWD" && (force || isStale(cached.get(`fx:${c}`), TTL_MS.fx)));

  const errors: string[] = [];
  const quotes: Quote[] = [];

  const tasks: Promise<void>[] = [
    ...symbols.map(async (s) => {
      const q = await fetchTwStock(s).catch((e) => {
        errors.push(`台股 ${s}: ${(e as Error).message}`);
        return null;
      });
      if (q) quotes.push(q);
      else if (!errors.some((m) => m.startsWith(`台股 ${s}`))) errors.push(`台股 ${s}: 查無報價`);
    }),
    fetchCrypto(coins)
      .then((qs) => void quotes.push(...qs))
      .catch((e) => void errors.push(`加密貨幣: ${(e as Error).message}`)),
    fetchFx(currencies)
      .then((qs) => void quotes.push(...qs))
      .catch((e) => void errors.push(`匯率: ${(e as Error).message}`)),
  ];
  // SinoPac futures equity rides along: it is stored on its own rows, not as a quote.
  let synced = 0;
  if (force || sinopacStale()) {
    tasks.push(
      syncSinopac().then((r) => {
        synced = r.synced;
        if (r.error) errors.push(r.error);
      }),
    );
  }
  await Promise.all(tasks);

  if (quotes.length) saveQuotes(quotes);
  if (errors.length) console.warn("[prices] refresh errors:", errors);
  return { updated: quotes.length + synced, errors };
}

// ---------- lookups used when adding holdings ----------

const globalForInfo = globalThis as unknown as { __twStockInfo?: { at: number; map: Map<string, string> } };

/** Stock code → Chinese name, from FinMind TaiwanStockInfo (cached for a day). */
export async function lookupTwStockName(symbol: string): Promise<string | null> {
  const cache = globalForInfo.__twStockInfo;
  if (!cache || Date.now() - cache.at > 86_400_000) {
    try {
      const r = await getJson<FinmindResp<{ stock_id: string; stock_name: string }>>(
        `${FINMIND}/data?dataset=TaiwanStockInfo`,
        finmindHeaders(),
      );
      globalForInfo.__twStockInfo = {
        at: Date.now(),
        map: new Map((r.data ?? []).map((d) => [d.stock_id, d.stock_name])),
      };
    } catch (e) {
      console.warn("[prices] TaiwanStockInfo failed:", (e as Error).message);
      return null;
    }
  }
  return globalForInfo.__twStockInfo!.map.get(symbol) ?? null;
}

/** Resolve a ticker like "BTC" to a CoinGecko coin id, preferring the highest market cap. */
export async function resolveCoin(query: string): Promise<{ id: string; symbol: string; name: string } | null> {
  const q = query.trim();
  const r = await getJson<{ coins: { id: string; symbol: string; name: string; market_cap_rank: number | null }[] }>(
    `${COINGECKO}/search?query=${encodeURIComponent(q)}`,
    coingeckoHeaders(),
  );
  const exactId = r.coins.find((c) => c.id === q.toLowerCase());
  if (exactId) return exactId;
  const bySymbol = r.coins
    .filter((c) => c.symbol.toLowerCase() === q.toLowerCase())
    .sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
  return bySymbol[0] ?? null;
}
