// Taiwan stock trading costs. Pure, so the transaction form can preview the same defaults the server applies.

/** 手續費 list rate; brokers discount it (電子下單 2.8–6 折), set per account as fee_discount. */
export const TW_COMMISSION_RATE = 0.001425;

/** Brokers' minimum commission: NT$20 for board lots; most charge NT$1 for odd lots (零股). */
const minCommission = (shares: number) => (shares % 1000 === 0 ? 20 : 1);

/** TWSE ETF codes start with 00; bond ETFs end in B. */
export const isTwEtf = (symbol: string) => /^00/.test(symbol);
const isBondEtf = (symbol: string) => /^00\w*B$/.test(symbol);

/** 證券交易稅 on the sell side: 0.3% for shares, 0.1% for ETFs; bond ETFs are exempt through 2026-12-31. */
export function twTransactionTaxRate(symbol: string, date: string): number {
  if (isBondEtf(symbol) && date <= "2026-12-31") return 0;
  return isTwEtf(symbol) ? 0.001 : 0.003;
}

/** Default commission and tax for a trade; both are rounded down, as brokers do. */
export function twTradeCosts(t: {
  side: "buy" | "sell";
  symbol: string;
  shares: number;
  price: number;
  date: string;
  feeDiscount?: number | null;
}): { fee: number; tax: number } {
  const value = t.shares * t.price;
  if (!(value > 0)) return { fee: 0, tax: 0 };
  const fee = Math.max(minCommission(t.shares), Math.floor(value * TW_COMMISSION_RATE * (t.feeDiscount ?? 1)));
  const tax = t.side === "sell" ? Math.floor(value * twTransactionTaxRate(t.symbol, t.date)) : 0;
  return { fee, tax };
}
