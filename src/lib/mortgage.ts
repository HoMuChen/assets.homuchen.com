import type { Property } from "./db";

export type MortgageStatus = {
  balance: number;
  monthlyPayment: number;
  paymentsMade: number;
  inGrace: boolean;
  /** Share of the original principal already repaid, 0–1. */
  paidRatio: number;
  isOverride: boolean;
};

/** Whole months between two dates, counting a month once its day-of-month has passed. */
function monthsBetween(start: Date, end: Date): number {
  let m = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) m -= 1;
  return Math.max(0, m);
}

/**
 * Remaining principal of an equal-payment (本息平均攤還) loan with an optional
 * interest-only grace period (寬限期), given how many monthly payments have been made.
 */
export function mortgageStatus(p: Property, now: Date = new Date()): MortgageStatus {
  const P = p.loan_amount;
  const r = p.annual_rate / 100 / 12;
  const grace = Math.min(p.grace_months, p.term_months);
  const n = p.term_months - grace;

  const paymentsMade = p.loan_start_date
    ? Math.min(p.term_months, monthsBetween(new Date(p.loan_start_date), now))
    : 0;

  const amortPayment = n <= 0 ? 0 : r === 0 ? P / n : (P * r) / (1 - Math.pow(1 + r, -n));
  const inGrace = paymentsMade < grace;

  let balance: number;
  if (inGrace || n <= 0) {
    balance = P;
  } else {
    const j = paymentsMade - grace;
    balance = r === 0 ? P - amortPayment * j : P * Math.pow(1 + r, j) - (amortPayment * (Math.pow(1 + r, j) - 1)) / r;
  }
  balance = Math.max(0, balance);

  const isOverride = p.balance_override != null;
  if (isOverride) balance = p.balance_override!;

  return {
    balance,
    monthlyPayment: inGrace ? P * r : amortPayment,
    paymentsMade,
    inGrace,
    paidRatio: P > 0 ? 1 - balance / P : 1,
    isOverride,
  };
}
