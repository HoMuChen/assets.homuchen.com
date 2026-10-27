import Link from "next/link";
import { TransactionForm } from "@/components/forms";
import { RefreshBar } from "@/components/refresh-bar";
import { SummaryStrip } from "@/components/summary-strip";
import { Badge, Card, Delta, Empty, HoldingLink, PageHeader, td, th, tr } from "@/components/ui";
import { fmtNum, fmtPct, fmtPrice, fmtTime, fmtTwd } from "@/lib/format";
import { getAccounts, ledgerIncome } from "@/lib/ledger";
import { getPortfolio } from "@/lib/portfolio";
import { taipeiDate } from "@/lib/time";

export default function StocksPage() {
  const p = getPortfolio();
  const today = taipeiDate();
  const accounts = getAccounts("stock").map((a) => ({ name: a.name, feeDiscount: a.fee_discount }));
  const income = ledgerIncome("stock", today.slice(0, 4));
  const rows = [...p.stocks].sort((a, b) => b.position.valueTwd - a.position.valueTwd);
  const total = p.totals.stocks;
  const cost = rows.reduce((a, r) => a + (r.position.costTwd ?? 0), 0);
  const valueWithCost = rows.filter((r) => r.position.costTwd != null).reduce((a, r) => a + r.position.valueTwd, 0);
  const pnl = valueWithCost - cost;
  const day = rows.reduce((a, r) => a + (r.position.dayChangeTwd ?? 0), 0);

  return (
    <>
      <PageHeader title="股票">
        <RefreshBar lastPriceAt={p.lastPriceAt} />
        <Link href="/transactions?kind=stock" className="rounded px-2 py-1 text-[12px] text-fg-3 hover:bg-hover hover:text-fg">
          交易紀錄
        </Link>
        <TransactionForm kind="stock" accounts={accounts} today={today} triggerLabel="記一筆" />
      </PageHeader>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-6 md:px-6">
        <SummaryStrip
          items={[
            { label: "股票市值", value: fmtTwd(total) },
            { label: "今日損益", value: <Delta value={day} pct={total ? (day / (total - day)) * 100 : null} /> },
            { label: "未實現損益", value: cost ? <Delta value={pnl} pct={(pnl / cost) * 100} /> : "—", sub: "僅計有填成本的部位" },
            {
              label: `${today.slice(0, 4)} 已實現損益`,
              value: <Delta value={income.realized} />,
              sub: `股利 ${fmtTwd(income.dividends)}`,
            },
          ]}
        />
        <Card className="overflow-hidden">
          {rows.length === 0 ? (
            <Empty>尚未有持股。點右上角「記一筆」輸入第一筆買進。</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>股票</th>
                    <th className={`${th} text-right`}>股數</th>
                    <th className={`${th} text-right`}>現價</th>
                    <th className={`${th} text-right`}>今日</th>
                    <th className={`${th} text-right`}>市值</th>
                    <th className={`${th} text-right`}>成本均價</th>
                    <th className={`${th} text-right`}>未實現損益</th>
                    {/* Below this width the row's action would scroll out of view. */}
                    <th className={`${th} hidden text-right min-[1440px]:table-cell`}>佔比</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const pos = r.position;
                    const gain = pos.costTwd != null ? pos.valueTwd - pos.costTwd : null;
                    return (
                      <tr key={pos.key} className={tr}>
                        <td className={td}>
                          <div className="flex items-center gap-2">
                            <HoldingLink accountId={r.accountId} asset={r.asset}>
                              <span className="num text-fg-3">{r.symbol}</span> <span className="text-fg">{r.name ?? ""}</span>
                            </HoldingLink>
                            {r.account && <span className="text-[12px] text-fg-4">{r.account}</span>}
                            {pos.price?.source === "finmind:daily" && <Badge>收盤價</Badge>}
                          </div>
                        </td>
                        <td className={`${td} num text-right`}>{fmtNum(r.quantity, 0)}</td>
                        <td className={`${td} num text-right`} title={`更新於 ${fmtTime(pos.price?.fetched_at)}`}>
                          {fmtPrice(pos.price?.price)}
                        </td>
                        <td className={`${td} text-right`}>
                          <Delta pct={pos.dayChangePct} showValue={false} />
                        </td>
                        <td className={`${td} num text-right`}>{fmtTwd(pos.valueTwd)}</td>
                        <td className={`${td} num text-right text-fg-3`}>{r.avgCost != null ? fmtPrice(r.avgCost) : "—"}</td>
                        <td className={`${td} text-right`}>
                          {gain != null ? <Delta value={gain} pct={pos.costTwd ? (gain / pos.costTwd) * 100 : null} /> : <span className="text-fg-4">—</span>}
                        </td>
                        <td className={`${td} num hidden text-right text-fg-3 min-[1440px]:table-cell`}>
                          {total ? fmtPct((pos.valueTwd / total) * 100, false) : "—"}
                        </td>
                        <td className={`${td} w-px text-right`}>
                          <TransactionForm
                            kind="stock"
                            accounts={accounts}
                            today={today}
                            preset={{ account: r.account, symbol: r.symbol }}
                            trigger="edit"
                            triggerLabel="交易"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
