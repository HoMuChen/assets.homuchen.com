import {
  db,
  type CashAccount,
  type CryptoHolding,
  type FuturesAccount,
  type FuturesPosition,
  type PriceRow,
  type Property,
  type StockHolding,
  type TwFuturesAccount,
} from "./db";
import { mortgageStatus, type MortgageStatus } from "./mortgage";
import { getPriceMap, USDT_COIN_ID } from "./prices";

export type Category = "cash" | "stocks" | "crypto" | "twFutures" | "realEstate";

export const CATEGORY_LABEL: Record<Category, string> = {
  cash: "現金",
  stocks: "股票",
  crypto: "加密貨幣",
  twFutures: "期貨",
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
export type FuturesPositionView = FuturesPosition & {
  /** Mark price in USDT (CoinGecko USD price ÷ USDT's USD price). */
  markUsdt: number | null;
  notionalUsdt: number;
  upnlUsdt: number;
  /** Unrealized PnL as % of initial margin when leverage is known, else % price move in the position's favour. */
  returnPct: number | null;
  dayChangeUsdt: number | null;
};
export type FuturesAccountView = FuturesAccount & {
  positions: FuturesPositionView[];
  upnlUsdt: number;
  equityUsdt: number;
  notionalUsdt: number;
  /** Σ notional ÷ equity — the account's real leverage, regardless of the per-position setting. */
  effectiveLeverage: number | null;
  position: Position;
};
/** Spot + futures combined, per coin. Positive = net long. */
export type CoinExposure = {
  coinId: string;
  symbol: string;
  spotQty: number;
  futuresQty: number;
  netQty: number;
  netValueTwd: number;
};
/** Taiwan futures account, valued at 權益數 (cash balance + open P&L), like the crypto futures accounts. */
export type TwFuturesPosition = TwFuturesAccount & { position: Position };
export type PropertyPosition = Property & {
  marketValue: number;
  equity: number;
  mortgage: MortgageStatus;
};

export type Portfolio = {
  cash: CashPosition[];
  stocks: StockPosition[];
  crypto: CryptoPosition[];
  futures: FuturesAccountView[];
  exposure: CoinExposure[];
  /** TWD per 1 USDT. */
  usdtTwd: number | null;
  twFutures: TwFuturesPosition[];
  properties: PropertyPosition[];
  totals: {
    cash: number;
    stocks: number;
    /** Spot holdings + futures account equity. */
    crypto: number;
    cryptoSpot: number;
    cryptoFutures: number;
    /** Equity of Taiwan futures accounts. */
    twFutures: number;
    /** Market value of properties (gross). */
    realEstate: number;
    realEstateEquity: number;
    mortgage: number;
    totalAssets: number;
    totalLiabilities: number;
    netWorth: number;
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

  const usdtTwd = prices.get(`crypto:${USDT_COIN_ID}`)?.price ?? null;
  const usdtUsd = prices.get(`crypto_usd:${USDT_COIN_ID}`)?.price ?? 1;
  const allFuturesPositions = conn.prepare("SELECT * FROM futures_positions ORDER BY id").all() as FuturesPosition[];
  const futures = (conn.prepare("SELECT * FROM futures_accounts ORDER BY id").all() as FuturesAccount[]).map((a) => {
    const positions = allFuturesPositions
      .filter((fp) => fp.account_id === a.id)
      .map((fp): FuturesPositionView => {
        const q = prices.get(`crypto_usd:${fp.coin_id}`);
        if (!q) missing.push(`${fp.symbol} 合約`);
        const mark = q ? q.price / usdtUsd : null;
        const dir = fp.side === "long" ? 1 : -1;
        const upnl = mark != null ? dir * fp.quantity * (mark - fp.entry_price) : 0;
        const priceMovePct = mark != null ? ((dir * (mark - fp.entry_price)) / fp.entry_price) * 100 : null;
        const dayMove = mark != null && q?.change_pct != null ? mark - mark / (1 + q.change_pct / 100) : null;
        return {
          ...fp,
          markUsdt: mark,
          notionalUsdt: (mark ?? fp.entry_price) * fp.quantity,
          upnlUsdt: upnl,
          returnPct: priceMovePct == null ? null : priceMovePct * (fp.leverage ?? 1),
          dayChangeUsdt: dayMove == null ? null : dir * fp.quantity * dayMove,
        };
      });
    const upnlUsdt = positions.reduce((x, fp) => x + fp.upnlUsdt, 0);
    const notionalUsdt = positions.reduce((x, fp) => x + fp.notionalUsdt, 0);
    const equityUsdt = a.wallet_balance + upnlUsdt;
    if (usdtTwd == null) missing.push(`${a.name} (USDT 匯率)`);
    const rate = usdtTwd ?? 0;
    const dayUsdt = positions.reduce((x, fp) => x + (fp.dayChangeUsdt ?? 0), 0);
    return {
      ...a,
      positions,
      upnlUsdt,
      equityUsdt,
      notionalUsdt,
      effectiveLeverage: equityUsdt > 0 ? notionalUsdt / equityUsdt : null,
      position: {
        category: "crypto" as const,
        key: `futures:${a.id}`,
        name: a.name,
        detail: `合約 · ${positions.length} 個部位`,
        valueTwd: equityUsdt * rate,
        costTwd: null,
        dayChangeTwd: positions.length ? dayUsdt * rate : null,
        dayChangePct: equityUsdt - dayUsdt > 0 && positions.length ? (dayUsdt / (equityUsdt - dayUsdt)) * 100 : null,
        price: null,
      },
    };
  });

  const exposureMap = new Map<string, CoinExposure>();
  const bump = (coinId: string, symbol: string, spot: number, fut: number) => {
    const e = exposureMap.get(coinId) ?? { coinId, symbol: symbol.toUpperCase(), spotQty: 0, futuresQty: 0, netQty: 0, netValueTwd: 0 };
    e.spotQty += spot;
    e.futuresQty += fut;
    exposureMap.set(coinId, e);
  };
  crypto.forEach((h) => bump(h.coin_id, h.symbol, h.amount, 0));
  allFuturesPositions.forEach((fp) => bump(fp.coin_id, fp.symbol, 0, (fp.side === "long" ? 1 : -1) * fp.quantity));
  const exposure = [...exposureMap.values()]
    .map((e) => {
      const netQty = e.spotQty + e.futuresQty;
      return { ...e, netQty, netValueTwd: netQty * (prices.get(`crypto:${e.coinId}`)?.price ?? 0) };
    })
    .sort((a, b) => Math.abs(b.netValueTwd) - Math.abs(a.netValueTwd));

  const twFutures = (conn.prepare("SELECT * FROM tw_futures_accounts ORDER BY equity DESC").all() as TwFuturesAccount[]).map(
    (a) => ({
      ...a,
      position: {
        category: "twFutures" as const,
        key: `twfut:${a.id}`,
        name: a.name,
        detail: [a.broker, a.source === "sinopac" ? "API 同步" : "手動"].filter(Boolean).join(" · "),
        valueTwd: a.equity,
        costTwd: null,
        dayChangeTwd: null,
        dayChangePct: null,
        price: null,
      },
    }),
  );

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
    cryptoSpot: sum(crypto.map((c) => c.position.valueTwd)),
    cryptoFutures: sum(futures.map((f) => f.position.valueTwd)),
    twFutures: sum(twFutures.map((f) => f.equity)),
    realEstate: sum(properties.map((p) => p.marketValue)),
    mortgage: sum(properties.map((p) => p.mortgage.balance)),
  };
  const cryptoTotal = t.cryptoSpot + t.cryptoFutures;
  const totalAssets = t.cash + t.stocks + cryptoTotal + t.twFutures + t.realEstate;
  const totalLiabilities = t.mortgage;

  const fetched = [...prices.values()].map((p) => p.fetched_at).sort();

  return {
    cash,
    stocks,
    crypto,
    futures,
    exposure,
    usdtTwd,
    twFutures,
    properties,
    totals: {
      ...t,
      crypto: cryptoTotal,
      realEstateEquity: t.realEstate - t.mortgage,
      totalAssets,
      totalLiabilities,
      netWorth: totalAssets - totalLiabilities,
    },
    missingPrices: missing,
    lastPriceAt: fetched[fetched.length - 1] ?? null,
  };
}
