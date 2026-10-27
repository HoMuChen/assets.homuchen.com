import { describe, expect, it } from "vitest";
import type { Property } from "./db";
import { mortgageStatus } from "./mortgage";

const loan = (p: Partial<Property> = {}): Property => ({
  id: 1,
  name: "家",
  cash_invested: 3_000_000,
  estimated_value: null,
  loan_amount: 1_000_000,
  annual_rate: 6,
  term_months: 360,
  grace_months: 0,
  loan_start_date: "2024-01-15",
  balance_override: null,
  note: null,
  ...p,
});

/** Month-by-month schedule: an independent check on the closed-form balance. */
function simulate(principal: number, annualRate: number, payment: number, months: number) {
  let balance = principal;
  for (let i = 0; i < months; i++) balance -= payment - balance * (annualRate / 100 / 12);
  return balance;
}

describe("mortgageStatus (本息平均攤還)", () => {
  it("computes the textbook payment: 1,000,000 at 6% over 30 years is 5,995.51 a month", () => {
    const m = mortgageStatus(loan(), new Date("2024-01-20"));
    expect(m.monthlyPayment).toBeCloseTo(5995.51, 2);
    expect(m.paymentsMade).toBe(0);
    expect(m.balance).toBe(1_000_000);
  });

  it("matches a month-by-month schedule after 12 and 120 payments", () => {
    const pmt = mortgageStatus(loan(), new Date("2024-01-20")).monthlyPayment;
    for (const [now, n] of [
      ["2025-01-15", 12],
      ["2034-01-15", 120],
    ] as const) {
      const m = mortgageStatus(loan(), new Date(now));
      expect(m.paymentsMade).toBe(n);
      expect(m.balance).toBeCloseTo(simulate(1_000_000, 6, pmt, n), 4);
    }
  });

  it("counts a month only once its day-of-month has passed", () => {
    expect(mortgageStatus(loan(), new Date("2024-03-14")).paymentsMade).toBe(1);
    expect(mortgageStatus(loan(), new Date("2024-03-15")).paymentsMade).toBe(2);
  });

  it("charges interest only during the grace period (寬限期), then amortises over the remaining term", () => {
    const p = loan({ loan_amount: 6_000_000, annual_rate: 2, grace_months: 24 });
    const inGrace = mortgageStatus(p, new Date("2025-06-20"));
    expect(inGrace.inGrace).toBe(true);
    expect(inGrace.balance).toBe(6_000_000);
    expect(inGrace.monthlyPayment).toBeCloseTo(10_000, 6); // 6,000,000 × 2% ÷ 12

    const after = mortgageStatus(p, new Date("2027-01-15")); // 36 payments: 24 grace + 12 amortising
    const r = 0.02 / 12;
    const amort = (6_000_000 * r) / (1 - Math.pow(1 + r, -336));
    expect(after.inGrace).toBe(false);
    expect(after.monthlyPayment).toBeCloseTo(amort, 6);
    expect(after.balance).toBeCloseTo(simulate(6_000_000, 2, amort, 12), 4);
  });

  it("splits principal evenly at a 0% rate", () => {
    const m = mortgageStatus(loan({ annual_rate: 0, loan_amount: 360_000 }), new Date("2025-01-15"));
    expect(m.monthlyPayment).toBe(1_000);
    expect(m.balance).toBe(348_000);
  });

  it("is fully repaid after the term, and never goes negative", () => {
    const m = mortgageStatus(loan({ term_months: 12 }), new Date("2030-01-01"));
    expect(m.paymentsMade).toBe(12);
    expect(m.balance).toBe(0);
    expect(m.paidRatio).toBe(1);
  });

  it("uses the manual balance after a prepayment", () => {
    const m = mortgageStatus(loan({ balance_override: 400_000 }), new Date("2025-01-15"));
    expect(m.isOverride).toBe(true);
    expect(m.balance).toBe(400_000);
    expect(m.paidRatio).toBeCloseTo(0.6, 10);
  });

  it("treats a loan without a start date as not yet repaying", () => {
    const m = mortgageStatus(loan({ loan_start_date: null }), new Date("2030-01-01"));
    expect(m.paymentsMade).toBe(0);
    expect(m.balance).toBe(1_000_000);
  });
});
