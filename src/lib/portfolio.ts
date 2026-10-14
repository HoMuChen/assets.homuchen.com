import { db, type CashAccount, type CryptoHolding, type PriceRow, type Property, type StockHolding } from "./db";
import { mortgageStatus, type MortgageStatus } from "./mortgage";
import { getPriceMap } from "./prices";

export type Category = "cash" | "stocks" | "crypto" | "realEstate";

export const CATEGORY_LABEL: Record<Category, string> = {
  cash: "現金",
  stocks: "股票",
  crypto: "加密貨幣",
  realEstate: "房地產",
};

export type Position = {
  category: Category;
  key: string;
  name: string;
  detail: string;
  valueTwd: number;
  costTwd: number | null;
  /** Change in TWD since previous close (stocks) / 24h (crypto). */
  dayChangeTwd: number | null;
  dayChangePct: number | null;
  price: PriceRow | null;
};

export type StockPosition = StockHolding & { position: Position };
export type CryptoPosition = CryptoHolding & { position: Position };
export type CashPosition = CashAccount & { position: Position; fxRate: number | null };
export type PropertyPosition = Property & {
  marketValue: number;
  equity: number;
  mortgage: MortgageStatus;
};

export type Portfolio = {
  cash: CashPosition[];
  stocks: StockPosition[];
  crypto: CryptoPosition[];
  properties: PropertyPosition[];
  totals: {
    cash: number;
    stocks: number;
    crypto: number;
    /** Market value of properties (gross). */
    realEstate: number;
    realEstateEquity: number;
    mortgage: number;
    totalAssets: number;
    totalLiabilities: number;
    netWorth: number;
    dayChange: number;
  };
  /** Holdings whose quote is missing, so their value counts as 0. */
  missingPrices: string[];
  lastPriceAt: string | null;
};

function dayChange(value: number, pct: number | null | undefined): number | null {
  if (pct == null) return null;
  // value is today's; back out yesterday's value from the % change.
  return value - value / (1 + pct / 100);
}

export function getPortfolio(): Portfolio {
  const conn = db();
  const prices = getPriceMap();
  const missing: string[] = [];

  const cash = (conn.prepare("SELECT * FROM cash_accounts ORDER BY balance DESC").all() as CashAccount[]).map((a) => {
    const fx = a.currency === "TWD" ? null : prices.get(`fx:${a.currency}`) ?? null;
    if (a.currency !== "TWD" && !fx) missing.push(`${a.name} (${a.currency} 匯率)`);
    const rate = a.currency === "TWD" ? 1 : fx?.price ?? 0;
    return {
      ...a,
      fxRate: fx?.price ?? null,
      position: {
        category: "cash" as const,
        key: `cash:${a.id}`,
        name: a.name,
        detail: [a.institution, a.currency].filter(Boolean).join(" · "),
        valueTwd: a.balance * rate,
        costTwd: null,
        dayChangeTwd: null,
        dayChangePct: null,
        price: fx,
      },
    };
  });

  const stocks = (conn.prepare("SELECT * FROM stock_holdings").all() as StockHolding[]).map((h) => {
    const q = prices.get(`tw:${h.symbol}`) ?? null;
    if (!q) missing.push(`${h.symbol} ${h.name ?? ""}`.trim());
    const value = (q?.price ?? 0) * h.shares;
    return {
      ...h,
      position: {
        category: "stocks" as const,
        key: `tw:${h.id}`,
        name: h.name ? `${h.name}` : h.symbol,
        detail: [h.symbol, h.broker].filter(Boolean).join(" · "),
        valueTwd: value,
        costTwd: h.avg_cost != null ? h.avg_cost * h.shares : null,
        dayChangeTwd: dayChange(value, q?.change_pct),
        dayChangePct: q?.change_pct ?? null,
        price: q,
      },
    };
  });

  const crypto = (conn.prepare("SELECT * FROM crypto_holdings").all() as CryptoHolding[]).map((h) => {
    const q = prices.get(`crypto:${h.coin_id}`) ?? null;
    if (!q) missing.push(h.symbol.toUpperCase());
    const value = (q?.price ?? 0) * h.amount;
    return {
      ...h,
      position: {
        category: "crypto" as const,
        key: `crypto:${h.id}`,
        name: h.symbol.toUpperCase(),
        detail: [h.name, h.location].filter(Boolean).join(" · "),
        valueTwd: value,
        costTwd: h.avg_cost_twd != null ? h.avg_cost_twd * h.amount : null,
        dayChangeTwd: dayChange(value, q?.change_pct),
        dayChangePct: q?.change_pct ?? null,
        price: q,
      },
    };
  });

  const properties = (conn.prepare("SELECT * FROM properties ORDER BY id").all() as Property[]).map((p) => {
    const mortgage = mortgageStatus(p);
    // Without an appraisal, value the property at cost (down payment + loan).
    const marketValue = p.estimated_value ?? p.cash_invested + p.loan_amount;
    return { ...p, mortgage, marketValue, equity: marketValue - mortgage.balance };
  });

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const t = {
    cash: sum(cash.map((c) => c.position.valueTwd)),
    stocks: sum(stocks.map((s) => s.position.valueTwd)),
    crypto: sum(crypto.map((c) => c.position.valueTwd)),
    realEstate: sum(properties.map((p) => p.marketValue)),
    mortgage: sum(properties.map((p) => p.mortgage.balance)),
  };
  const totalAssets = t.cash + t.stocks + t.crypto + t.realEstate;
  const totalLiabilities = t.mortgage;

  const fetched = [...prices.values()].map((p) => p.fetched_at).sort();

  return {
    cash,
    stocks,
    crypto,
    properties,
    totals: {
      ...t,
      realEstateEquity: t.realEstate - t.mortgage,
      totalAssets,
      totalLiabilities,
      netWorth: totalAssets - totalLiabilities,
      dayChange: sum([...stocks, ...crypto].map((h) => h.position.dayChangeTwd ?? 0)),
    },
    missingPrices: missing,
    lastPriceAt: fetched[fetched.length - 1] ?? null,
  };
}
