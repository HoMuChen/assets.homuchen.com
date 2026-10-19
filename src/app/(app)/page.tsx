import Link from "next/link";
import { NetWorthChart } from "@/components/charts";
import { RefreshBar } from "@/components/refresh-bar";
import { Badge, Card, CardHeader, CategoryDot, Delta, PageHeader, Stat, td, th, tr } from "@/components/ui";
import { CATEGORY_COLOR, CATEGORY_HREF, CATEGORY_ORDER } from "@/lib/categories";
import { fmtPct, fmtTwd } from "@/lib/format";
import { CATEGORY_LABEL, getPortfolio, type Category } from "@/lib/portfolio";
import { getSnapshots } from "@/lib/snapshot";
import { taipeiDate } from "@/lib/time";
import { toTrend } from "@/lib/trend";

export default function OverviewPage() {
  const p = getPortfolio();
  const t = p.totals;
  const snapshots = getSnapshots();
  const today = taipeiDate();
  const prev = [...snapshots].reverse().find((s) => s.date < today);
  const vsPrev = prev ? t.netWorth - prev.net_worth : null;
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

  // Net-worth composition: real estate counts as equity (market value − mortgage).
  const parts: Record<Category, number> = {
    stocks: t.stocks,
    crypto: t.crypto,
    cash: t.cash,
    twFutures: t.twFutures,
    realEstate: t.realEstateEquity,
  };
  const positive = CATEGORY_ORDER.reduce((a, c) => a + Math.max(0, parts[c]), 0);
  const share = (c: Category) => (positive > 0 ? (Math.max(0, parts[c]) / positive) * 100 : 0);
  // Largest share first; negative equity (share 0) sinks to the bottom.
  const allocation = [...CATEGORY_ORDER].sort((a, b) => parts[b] - parts[a]);

  const positions = [...p.stocks, ...p.crypto, ...p.futures, ...p.twFutures, ...p.cash]
    .map((x) => x.position)
    .sort((a, b) => b.valueTwd - a.valueTwd)
    .slice(0, 10);

  // Chart ends at the live number shown in the hero, not at today's (possibly stale) snapshot.
  const trend = [
    ...toTrend(snapshots.filter((s) => s.date < today)),
    {
      date: today,
      netWorth: t.netWorth,
      stocks: t.stocks,
      crypto: t.crypto,
      cash: t.cash,
      twFutures: t.twFutures,
      realEstateEquity: t.realEstateEquity,
    },
  ];

  const isEmpty =
    p.cash.length + p.stocks.length + p.crypto.length + p.futures.length + p.twFutures.length + p.properties.length === 0;

  return (
    <>
      <PageHeader title="總覽">
        <RefreshBar lastPriceAt={p.lastPriceAt} />
      </PageHeader>

      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-6 md:px-6">
        {/* Hero */}
        <div className="flex flex-col gap-2 px-1">
          <span className="text-[12px] text-fg-3">淨資產</span>
          <div className="num text-[34px] font-semibold leading-none tracking-tight md:text-[40px]">{fmtTwd(t.netWorth)}</div>
          {prev && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
              <span className="flex items-center gap-1.5 text-fg-3">
                {prev.date === yesterday ? "較昨日" : `較 ${prev.date.slice(5).replace("-", "/")}`}{" "}
                <Delta value={vsPrev} pct={prev.net_worth ? (vsPrev! / Math.abs(prev.net_worth)) * 100 : null} />
              </span>
            </div>
          )}
          {p.missingPrices.length > 0 && (
            <div className="mt-1">
              <Badge tone="warning">⚠ 尚無報價，暫以 0 計：{p.missingPrices.join("、")}</Badge>
            </div>
          )}
        </div>

        {isEmpty && (
          <Card className="px-5 py-6 text-[13px] text-fg-2">
            還沒有任何資產。從左側選單的 <Link className="text-accent" href="/stocks">股票</Link>、
            <Link className="text-accent" href="/crypto">加密貨幣</Link>、<Link className="text-accent" href="/cash">現金</Link>、
            <Link className="text-accent" href="/futures">期貨</Link>、
            <Link className="text-accent" href="/real-estate">房地產</Link> 開始新增。
          </Card>
        )}

        {/* KPI row */}
        <Card className="grid grid-cols-2 divide-line md:grid-cols-4 md:divide-x [&>*:nth-child(n+3)]:border-t [&>*:nth-child(n+3)]:border-line md:[&>*:nth-child(n+3)]:border-t-0">
          <Stat label="總資產" value={fmtTwd(t.totalAssets)} sub="含房地產市值" />
          <Stat label="總負債" value={fmtTwd(t.totalLiabilities)} sub="房貸剩餘本金" />
          <Stat
            label="負債比"
            value={t.totalAssets > 0 ? fmtPct((t.totalLiabilities / t.totalAssets) * 100, false) : "—"}
            sub="總負債 ÷ 總資產"
          />
          <Stat label="流動資產" value={fmtTwd(t.cash + t.stocks + t.crypto + t.twFutures)} sub="現金、股票、加密貨幣、期貨" />
        </Card>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <NetWorthChart data={trend} title="淨資產走勢" />
          </Card>

          {/* Allocation */}
          <Card>
            <CardHeader title="淨資產配置" />
            <div className="px-4 pt-4">
              <div className="flex h-2 gap-[2px] overflow-hidden rounded-full bg-panel-2" role="img" aria-label="淨資產配置比例">
                {allocation.filter((c) => share(c) > 0).map((c) => (
                  <div key={c} style={{ width: `${share(c)}%`, background: CATEGORY_COLOR[c] }} />
                ))}
              </div>
            </div>
            <ul className="flex flex-col py-2">
              {allocation.map((c) => (
                <li key={c}>
                  <Link href={CATEGORY_HREF[c]} className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-hover">
                    <CategoryDot color={CATEGORY_COLOR[c]} />
                    <span className="flex-1 text-fg-2">
                      {CATEGORY_LABEL[c]}
                      {c === "realEstate" && <span className="ml-1 text-[11px] text-fg-4">淨值</span>}
                    </span>
                    <span className="num text-fg">{fmtTwd(parts[c])}</span>
                    <span className="num w-14 text-right text-[12px] text-fg-3">{fmtPct(share(c), false)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {p.properties.length > 0 && (
              <div className="border-t border-line px-4 py-3 text-[12px] text-fg-3">
                <div className="flex justify-between">
                  <span>房地產市值</span>
                  <span className="num text-fg-2">{fmtTwd(t.realEstate)}</span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span>房貸剩餘</span>
                  <span className="num text-fg-2">-{fmtTwd(t.mortgage)}</span>
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* Top holdings */}
        {positions.length > 0 && (
          <Card className="overflow-hidden">
            <CardHeader title="主要部位" />
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>名稱</th>
                    <th className={`${th} text-right`}>市值</th>
                    <th className={`${th} text-right`}>今日</th>
                    <th className={`${th} text-right`}>佔淨資產</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((pos) => (
                    <tr key={pos.key} className={tr}>
                      <td className={td}>
                        <Link href={CATEGORY_HREF[pos.category]} className="flex items-center gap-2.5">
                          <CategoryDot color={CATEGORY_COLOR[pos.category]} />
                          <span className="text-fg">{pos.name}</span>
                          <span className="text-[12px] text-fg-4">{pos.detail}</span>
                        </Link>
                      </td>
                      <td className={`${td} num text-right`}>{fmtTwd(pos.valueTwd)}</td>
                      <td className={`${td} text-right`}>
                        <Delta value={pos.dayChangeTwd} pct={pos.dayChangePct} />
                      </td>
                      <td className={`${td} num text-right text-fg-3`}>
                        {t.netWorth > 0 ? fmtPct((pos.valueTwd / t.netWorth) * 100, false) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
