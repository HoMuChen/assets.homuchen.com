import { TwFuturesForm } from "@/components/forms";
import { RefreshBar } from "@/components/refresh-bar";
import { SummaryStrip } from "@/components/summary-strip";
import { Badge, Card, Delta, Empty, PageHeader, td, th, tr } from "@/components/ui";
import { fmtPct, fmtTime, fmtTwd } from "@/lib/format";
import { getPortfolio } from "@/lib/portfolio";
import { sinopacConfigured } from "@/lib/tw-futures";

export default function FuturesPage() {
  const p = getPortfolio();
  const rows = p.twFutures;
  const total = p.totals.twFutures;
  const synced = rows.filter((r) => r.source === "sinopac");
  const openPnl = synced.reduce((a, r) => a + (r.open_pnl ?? 0), 0);
  const sinopacAvailable = sinopacConfigured();
  const lastSync = synced.map((r) => r.synced_at).filter(Boolean).sort().at(-1) ?? null;

  return (
    <>
      <PageHeader title="期貨">
        {synced.length > 0 && <RefreshBar lastPriceAt={lastSync} />}
        <TwFuturesForm sinopacAvailable={sinopacAvailable} />
      </PageHeader>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-6 md:px-6">
        <SummaryStrip
          items={[
            { label: "權益數合計", value: fmtTwd(total), sub: "計入淨資產" },
            {
              label: "未平倉損益",
              value: synced.length ? <Delta value={openPnl} /> : "—",
              sub: synced.length ? "API 同步的帳戶" : "手動帳戶不含明細",
            },
            { label: "帳戶數", value: rows.length },
          ]}
        />
        <Card className="overflow-hidden">
          {rows.length === 0 ? (
            <Empty>尚未新增期貨帳戶。點右上角「新增」。</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>帳戶</th>
                    <th className={`${th} text-right`}>權益數</th>
                    <th className={`${th} text-right`}>未平倉損益</th>
                    <th className={`${th} text-right`}>可用保證金</th>
                    <th className={`${th} text-right`}>風險指標</th>
                    <th className={`${th} text-right`}>更新時間</th>
                    <th className={`${th} text-right`}>佔比</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const api = r.source === "sinopac";
                    return (
                      <tr key={r.id} className={tr}>
                        <td className={td}>
                          <div className="flex items-center gap-2">
                            <span className="text-fg">{r.name}</span>
                            {r.broker && <span className="text-[12px] text-fg-4">{r.broker}</span>}
                            <Badge>{api ? "API 同步" : "手動"}</Badge>
                            {r.sync_error && (
                              <span title={r.sync_error}>
                                <Badge tone="warning">⚠ 同步失敗</Badge>
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={`${td} num text-right`}>{fmtTwd(r.equity)}</td>
                        <td className={`${td} text-right`}>{api ? <Delta value={r.open_pnl} /> : <span className="text-fg-4">—</span>}</td>
                        <td className={`${td} num text-right text-fg-3`}>{api ? fmtTwd(r.available_margin) : "—"}</td>
                        <td className={`${td} num text-right text-fg-3`}>
                          {api && r.risk_indicator ? fmtPct(r.risk_indicator, false) : "—"}
                        </td>
                        <td className={`${td} num text-right text-fg-3`}>{fmtTime(api ? r.synced_at : `${r.updated_at.replace(" ", "T")}Z`)}</td>
                        <td className={`${td} num text-right text-fg-3`}>{total ? fmtPct((r.equity / total) * 100, false) : "—"}</td>
                        <td className={`${td} w-px text-right`}>
                          <TwFuturesForm item={r} sinopacAvailable={sinopacAvailable} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <p className="px-1 text-[12px] text-fg-4">
          淨資產只計入權益數（帳戶餘額＋未平倉損益）。API 同步的帳戶在期貨交易時段每 5 分鐘更新，其餘時間每小時更新；手動帳戶請在權益數變動後自行更新。
        </p>
      </div>
    </>
  );
}
