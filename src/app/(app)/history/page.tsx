import { HistoryChart } from "@/components/charts";
import { SnapshotButton } from "@/components/snapshot-button";
import { Card, CardHeader, Delta, Empty, PageHeader, td, th, tr } from "@/components/ui";
import { fmtTwd } from "@/lib/format";
import { getSnapshots } from "@/lib/snapshot";
import { toTrend } from "@/lib/trend";

export default function HistoryPage() {
  const snapshots = getSnapshots();
  const desc = [...snapshots].reverse();

  return (
    <>
      <PageHeader title="歷史快照">
        <SnapshotButton />
      </PageHeader>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-6 md:px-6">
        <Card>
          <HistoryChart data={toTrend(snapshots)} />
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="每日快照" right={<span className="text-[12px] text-fg-4">每天 23:55（台北時間）自動記錄</span>} />
          {desc.length === 0 ? (
            <Empty>還沒有快照。</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>日期</th>
                    <th className={`${th} text-right`}>淨資產</th>
                    <th className={`${th} text-right`}>較前次</th>
                    <th className={`${th} text-right`}>股票</th>
                    <th className={`${th} text-right`}>加密貨幣</th>
                    <th className={`${th} text-right`}>現金</th>
                    <th className={`${th} text-right`}>期貨</th>
                    <th className={`${th} text-right`}>房產市值</th>
                    <th className={`${th} text-right`}>房貸</th>
                  </tr>
                </thead>
                <tbody>
                  {desc.map((s, i) => {
                    const prev = desc[i + 1];
                    const diff = prev ? s.net_worth - prev.net_worth : null;
                    return (
                      <tr key={s.date} className={tr}>
                        <td className={`${td} num text-fg-2`}>{s.date}</td>
                        <td className={`${td} num text-right text-fg`}>{fmtTwd(s.net_worth)}</td>
                        <td className={`${td} text-right`}>
                          <Delta value={diff} pct={prev && prev.net_worth ? (diff! / Math.abs(prev.net_worth)) * 100 : null} />
                        </td>
                        <td className={`${td} num text-right text-fg-2`}>{fmtTwd(s.stocks)}</td>
                        <td className={`${td} num text-right text-fg-2`}>{fmtTwd(s.crypto)}</td>
                        <td className={`${td} num text-right text-fg-2`}>{fmtTwd(s.cash)}</td>
                        <td className={`${td} num text-right text-fg-2`}>{fmtTwd(s.tw_futures)}</td>
                        <td className={`${td} num text-right text-fg-2`}>{fmtTwd(s.real_estate)}</td>
                        <td className={`${td} num text-right text-fg-3`}>-{fmtTwd(s.mortgage)}</td>
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
