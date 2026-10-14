import { db, type SnapshotRow } from "./db";
import { getPortfolio } from "./portfolio";
import { refreshPrices } from "./prices";
import { taipeiDate } from "./time";

/** Refresh all quotes, then write (or overwrite) today's snapshot. */
export async function takeSnapshot(): Promise<SnapshotRow> {
  await refreshPrices({ force: true });
  const p = getPortfolio();
  const date = taipeiDate();

  const detail = {
    positions: [
      ...p.cash.map((c) => c.position),
      ...p.stocks.map((s) => ({ ...s.position, quantity: s.shares, price: s.position.price?.price ?? null })),
      ...p.crypto.map((c) => ({ ...c.position, quantity: c.amount, price: c.position.price?.price ?? null })),
    ].map(({ category, key, name, valueTwd, ...rest }) => ({
      category,
      key,
      name,
      valueTwd,
      ...("quantity" in rest ? { quantity: rest.quantity, price: rest.price } : {}),
    })),
    futures: p.futures.map((a) => ({
      id: a.id,
      name: a.name,
      walletUsdt: a.wallet_balance,
      equityUsdt: a.equityUsdt,
      equityTwd: a.position.valueTwd,
      positions: a.positions.map((fp) => ({
        symbol: fp.symbol,
        side: fp.side,
        quantity: fp.quantity,
        entry: fp.entry_price,
        mark: fp.markUsdt,
        upnlUsdt: fp.upnlUsdt,
      })),
    })),
    usdtTwd: p.usdtTwd,
    properties: p.properties.map((x) => ({
      id: x.id,
      name: x.name,
      marketValue: x.marketValue,
      mortgage: x.mortgage.balance,
      equity: x.equity,
    })),
    missingPrices: p.missingPrices,
  };

  const row = {
    date,
    net_worth: p.totals.netWorth,
    total_assets: p.totals.totalAssets,
    total_liabilities: p.totals.totalLiabilities,
    cash: p.totals.cash,
    stocks: p.totals.stocks,
    crypto: p.totals.crypto,
    real_estate: p.totals.realEstate,
    mortgage: p.totals.mortgage,
    detail: JSON.stringify(detail),
  };

  db()
    .prepare(
      `INSERT INTO snapshots (date, net_worth, total_assets, total_liabilities, cash, stocks, crypto, real_estate, mortgage, detail, created_at)
       VALUES (@date, @net_worth, @total_assets, @total_liabilities, @cash, @stocks, @crypto, @real_estate, @mortgage, @detail, datetime('now'))
       ON CONFLICT(date) DO UPDATE SET net_worth=excluded.net_worth, total_assets=excluded.total_assets,
         total_liabilities=excluded.total_liabilities, cash=excluded.cash, stocks=excluded.stocks, crypto=excluded.crypto,
         real_estate=excluded.real_estate, mortgage=excluded.mortgage, detail=excluded.detail, created_at=excluded.created_at`,
    )
    .run(row);

  console.log(`[snapshot] ${date} net worth ${Math.round(p.totals.netWorth)}`);
  return db().prepare("SELECT * FROM snapshots WHERE date = ?").get(date) as SnapshotRow;
}

export function getSnapshots(): SnapshotRow[] {
  return db().prepare("SELECT * FROM snapshots ORDER BY date ASC").all() as SnapshotRow[];
}

export function hasSnapshot(date: string): boolean {
  return !!db().prepare("SELECT 1 FROM snapshots WHERE date = ?").get(date);
}
