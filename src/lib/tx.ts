// Ledger vocabulary shared with client components (src/lib/ledger.ts itself needs the database).

import type { TxType } from "./db";

export const TX_LABEL: Record<TxType, string> = {
  open: "期初",
  buy: "買進",
  sell: "賣出",
  dividend: "股利",
  deposit: "入金",
  withdraw: "出金",
  transfer: "轉帳",
  fee: "費用",
  tax: "稅",
  adjust: "調整",
  funding: "資金費率",
  pnl: "平倉損益",
};

/** 'tw:2330' → '2330', 'crypto:bitcoin' → 'bitcoin'. */
export const assetId = (asset: string) => asset.slice(asset.indexOf(":") + 1);
