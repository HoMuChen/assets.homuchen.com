import { legacyCash, legacyHoldings } from "./legacy";
import { ledgerCash, ledgerHoldings, ledgerMode, type CashBalance, type Holding } from "./ledger";

/** Stocks, coins and cash balances from whichever side is the source of truth (see ledgerMode). */
export function getHoldings(): { cash: CashBalance[]; stocks: Holding[]; crypto: Holding[] } {
  return ledgerMode() === "primary"
    ? { cash: ledgerCash(), stocks: ledgerHoldings("stock"), crypto: ledgerHoldings("crypto") }
    : { cash: legacyCash(), stocks: legacyHoldings("stock"), crypto: legacyHoldings("crypto") };
}
