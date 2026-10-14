import { CashForm } from "@/components/forms";
import { SummaryStrip } from "@/components/summary-strip";
import { Card, Empty, PageHeader, td, th, tr } from "@/components/ui";
import { fmtNum, fmtPct, fmtPrice, fmtTwd } from "@/lib/format";
import { getPortfolio } from "@/lib/portfolio";

export default function CashPage() {
  const p = getPortfolio();
  const rows = [...p.cash].sort((a, b) => b.position.valueTwd - a.position.valueTwd);
  const total = p.totals.cash;
  const foreign = rows.filter((r) => r.currency !== "TWD").reduce((a, r) => a + r.position.valueTwd, 0);

  return (
    <>
      <PageHeader title="現金">
        <CashForm />
      </PageHeader>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-6 md:px-6">
        <SummaryStrip
          items={[
            { label: "現金總額", value: fmtTwd(total) },
            { label: "外幣部位", value: fmtTwd(foreign), sub: total ? `${fmtPct((foreign / total) * 100, false)} of 現金` : undefined },
            { label: "帳戶數", value: rows.length },
          ]}
        />
        <Card className="overflow-hidden">
          {rows.length === 0 ? (
            <Empty>尚未新增現金帳戶。點右上角「新增」。</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>帳戶</th>
                    <th className={th}>幣別</th>
                    <th className={`${th} text-right`}>餘額</th>
                    <th className={`${th} text-right`}>匯率</th>
                    <th className={`${th} text-right`}>折合台幣</th>
                    <th className={`${th} text-right`}>佔比</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={tr}>
                      <td className={td}>
                        <div className="flex items-center gap-2">
                          <span className="text-fg">{r.name}</span>
                          {r.institution && <span className="text-[12px] text-fg-4">{r.institution}</span>}
                        </div>
                      </td>
                      <td className={`${td} text-fg-3`}>{r.currency}</td>
                      <td className={`${td} num text-right`}>{fmtNum(r.balance, 2)}</td>
                      <td className={`${td} num text-right text-fg-3`}>{r.currency === "TWD" ? "—" : fmtPrice(r.fxRate)}</td>
                      <td className={`${td} num text-right`}>{fmtTwd(r.position.valueTwd)}</td>
                      <td className={`${td} num text-right text-fg-3`}>{total ? fmtPct((r.position.valueTwd / total) * 100, false) : "—"}</td>
                      <td className={`${td} w-px text-right`}>
                        <CashForm item={r} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
