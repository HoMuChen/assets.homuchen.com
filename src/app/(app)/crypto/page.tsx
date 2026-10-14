import { CryptoForm } from "@/components/forms";
import { RefreshBar } from "@/components/refresh-bar";
import { SummaryStrip } from "@/components/summary-strip";
import { Card, Delta, Empty, PageHeader, td, th, tr } from "@/components/ui";
import { fmtNum, fmtPct, fmtPrice, fmtTime, fmtTwd } from "@/lib/format";
import { getPortfolio } from "@/lib/portfolio";

export default function CryptoPage() {
  const p = getPortfolio();
  const rows = [...p.crypto].sort((a, b) => b.position.valueTwd - a.position.valueTwd);
  const total = p.totals.crypto;
  const cost = rows.reduce((a, r) => a + (r.position.costTwd ?? 0), 0);
  const valueWithCost = rows.filter((r) => r.position.costTwd != null).reduce((a, r) => a + r.position.valueTwd, 0);
  const pnl = valueWithCost - cost;
  const day = rows.reduce((a, r) => a + (r.position.dayChangeTwd ?? 0), 0);

  return (
    <>
      <PageHeader title="加密貨幣">
        <RefreshBar lastPriceAt={p.lastPriceAt} />
        <CryptoForm />
      </PageHeader>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-6 md:px-6">
        <SummaryStrip
          items={[
            { label: "加密貨幣市值", value: fmtTwd(total) },
            { label: "24h 變動", value: <Delta value={day} pct={total ? (day / (total - day)) * 100 : null} /> },
            { label: "未實現損益", value: cost ? <Delta value={pnl} pct={(pnl / cost) * 100} /> : "—", sub: "僅計有填成本的部位" },
            { label: "幣種數", value: rows.length },
          ]}
        />
        <Card className="overflow-hidden">
          {rows.length === 0 ? (
            <Empty>尚未新增加密貨幣。點右上角「新增」輸入幣種與數量。</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>幣種</th>
                    <th className={`${th} text-right`}>數量</th>
                    <th className={`${th} text-right`}>現價 (TWD)</th>
                    <th className={`${th} text-right`}>24h</th>
                    <th className={`${th} text-right`}>市值</th>
                    <th className={`${th} text-right`}>未實現損益</th>
                    <th className={`${th} text-right`}>佔比</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const pos = r.position;
                    const gain = pos.costTwd != null ? pos.valueTwd - pos.costTwd : null;
                    return (
                      <tr key={r.id} className={tr}>
                        <td className={td}>
                          <div className="flex items-center gap-2">
                            <span className="text-fg">{r.symbol.toUpperCase()}</span>
                            <span className="text-[12px] text-fg-4">{[r.name, r.location].filter(Boolean).join(" · ")}</span>
                          </div>
                        </td>
                        <td className={`${td} num text-right`}>{fmtNum(r.amount, 8)}</td>
                        <td className={`${td} num text-right`} title={`更新於 ${fmtTime(pos.price?.fetched_at)}`}>
                          {fmtPrice(pos.price?.price)}
                        </td>
                        <td className={`${td} text-right`}>
                          <Delta pct={pos.dayChangePct} showValue={false} />
                        </td>
                        <td className={`${td} num text-right`}>{fmtTwd(pos.valueTwd)}</td>
                        <td className={`${td} text-right`}>
                          {gain != null ? <Delta value={gain} pct={pos.costTwd ? (gain / pos.costTwd) * 100 : null} /> : <span className="text-fg-4">—</span>}
                        </td>
                        <td className={`${td} num text-right text-fg-3`}>{total ? fmtPct((pos.valueTwd / total) * 100, false) : "—"}</td>
                        <td className={`${td} w-px text-right`}>
                          <CryptoForm item={r} />
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
