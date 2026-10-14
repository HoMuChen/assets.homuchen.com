import { PropertyForm } from "@/components/forms";
import { SummaryStrip } from "@/components/summary-strip";
import { Badge, Card, Delta, Empty, PageHeader } from "@/components/ui";
import { fmtPct, fmtTwd } from "@/lib/format";
import { getPortfolio } from "@/lib/portfolio";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-fg-3">{label}</span>
      <span className="num text-fg">{children}</span>
    </div>
  );
}

export default function RealEstatePage() {
  const p = getPortfolio();
  const t = p.totals;
  const invested = p.properties.reduce((a, x) => a + x.cash_invested, 0);

  return (
    <>
      <PageHeader title="房地產">
        <PropertyForm />
      </PageHeader>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-6 md:px-6">
        <SummaryStrip
          items={[
            { label: "房產市值", value: fmtTwd(t.realEstate) },
            { label: "房貸剩餘", value: fmtTwd(t.mortgage) },
            { label: "房產淨值", value: fmtTwd(t.realEstateEquity), sub: "市值 − 房貸" },
            { label: "投入現金", value: fmtTwd(invested) },
          ]}
        />

        {p.properties.length === 0 ? (
          <Card>
            <Empty>尚未新增房地產。點右上角「新增」輸入投入現金與房貸條件，剩餘本金會依撥款日自動計算。</Empty>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {p.properties.map((x) => {
              const m = x.mortgage;
              const gain = x.equity - x.cash_invested;
              return (
                <Card key={x.id}>
                  <div className="flex h-11 items-center justify-between border-b border-line px-4">
                    <div className="flex items-center gap-2">
                      <h2 className="text-[13px] font-medium">{x.name}</h2>
                      {x.estimated_value == null && <Badge>以成本計價</Badge>}
                      {m.inGrace && <Badge tone="warning">寬限期中</Badge>}
                    </div>
                    <PropertyForm item={x} />
                  </div>
                  <div className="grid grid-cols-1 gap-x-8 px-4 py-3 text-[13px] sm:grid-cols-2">
                    <div>
                      <Row label="市值">{fmtTwd(x.marketValue)}</Row>
                      <Row label="房貸剩餘">{fmtTwd(m.balance)}</Row>
                      <Row label="淨值">{fmtTwd(x.equity)}</Row>
                      <Row label="累計增值">
                        <Delta value={gain} pct={x.cash_invested ? (gain / x.cash_invested) * 100 : null} />
                      </Row>
                    </div>
                    <div>
                      <Row label="投入現金">{fmtTwd(x.cash_invested)}</Row>
                      <Row label="貸款總額">{fmtTwd(x.loan_amount)}</Row>
                      <Row label="利率 / 年限">
                        {x.annual_rate}% / {x.term_months / 12} 年
                      </Row>
                      <Row label={m.inGrace ? "月付（僅利息）" : "月付金"}>{fmtTwd(m.monthlyPayment)}</Row>
                    </div>
                  </div>
                  {x.loan_amount > 0 && (
                    <div className="border-t border-line px-4 py-3">
                      <div className="mb-2 flex justify-between text-[12px] text-fg-3">
                        <span>
                          已還本金 {fmtPct(m.paidRatio * 100, false)}
                          {m.isOverride && <span className="ml-1 text-fg-4">（手動覆寫）</span>}
                        </span>
                        <span className="num">
                          第 {m.paymentsMade} / {x.term_months} 期
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
                        <div className="h-full rounded-full bg-[var(--series-4)]" style={{ width: `${Math.min(100, m.paidRatio * 100)}%` }} />
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
