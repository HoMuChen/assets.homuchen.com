import type { TrendPoint } from "@/components/charts";
import type { SnapshotRow } from "./db";

export function toTrend(rows: SnapshotRow[]): TrendPoint[] {
  return rows.map((s) => ({
    date: s.date,
    netWorth: s.net_worth,
    stocks: s.stocks,
    crypto: s.crypto,
    cash: s.cash,
    twFutures: s.tw_futures,
    realEstateEquity: s.real_estate - s.mortgage,
  }));
}
