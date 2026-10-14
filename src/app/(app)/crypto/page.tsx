import { CryptoForm, FuturesAccountForm, FuturesPositionForm } from "@/components/forms";
import { RefreshBar } from "@/components/refresh-bar";
import { SummaryStrip } from "@/components/summary-strip";
import { Badge, Card, CardHeader, Delta, Empty, PageHeader, td, th, tr } from "@/components/ui";
import { fmtNum, fmtPct, fmtPrice, fmtTime, fmtTwd, fmtUsdt } from "@/lib/format";
import { getPortfolio, type FuturesAccountView } from "@/lib/portfolio";

/** Above this effective leverage the account gets a warning badge. */
const HIGH_LEVERAGE = 10;

function SideBadge({ side }: { side: "long" | "short" }) {
  return side === "long" ? (
    <span className="inline-flex h-5 items-center rounded border border-up/40 px-1.5 text-[11px] text-up">多</span>
  ) : (
    <span className="inline-flex h-5 items-center rounded border border-down/40 px-1.5 text-[11px] text-down">空</span>
  );
}

function MiniStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] text-fg-4">{label}</span>
      <span className="num truncate text-[13px] text-fg">{children}</span>
    </div>
  );
}

function FuturesAccountCard({ a, usdtTwd }: { a: FuturesAccountView; usdtTwd: number | null }) {
  const lev = a.effectiveLeverage;
  return (
    <Card className="overflow-hidden">
      <div className="flex h-11 items-center justify-between gap-2 border-b border-line px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-[13px] font-medium">{a.name}</h3>
          <Badge>U 本位</Badge>
          {a.equityUsdt <= 0 && <Badge tone="warning">⚠ 權益 ≤ 0</Badge>}
          {lev != null && lev > HIGH_LEVERAGE && <Badge tone="warning">⚠ 槓桿偏高</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <FuturesPositionForm accountId={a.id} />
          <FuturesAccountForm item={a} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 border-b border-line px-4 py-3 sm:grid-cols-5">
        <MiniStat label="錢包餘額 (USDT)">{fmtUsdt(a.wallet_balance)}</MiniStat>
        <MiniStat label="未實現損益 (USDT)">
          <Delta value={a.upnlUsdt} format={fmtUsdt} />
        </MiniStat>
        <MiniStat label="權益 (USDT)">
          {fmtUsdt(a.equityUsdt)}
          {usdtTwd != null && <span className="ml-1.5 text-[11px] text-fg-4">≈ {fmtTwd(a.position.valueTwd)}</span>}
        </MiniStat>
        <MiniStat label="名目曝險 (USDT)">{fmtUsdt(a.notionalUsdt)}</MiniStat>
        <MiniStat label="實際槓桿">
          <span className={lev != null && lev > HIGH_LEVERAGE ? "text-warning" : ""}>{lev != null ? `${lev.toFixed(2)}x` : "—"}</span>
        </MiniStat>
      </div>

      {a.positions.length === 0 ? (
        <Empty>尚無部位。點「新增部位」記錄目前持倉。</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr>
                <th className={th}>合約</th>
                <th className={`${th} text-right`}>數量</th>
                <th className={`${th} text-right`}>開倉均價</th>
                <th className={`${th} text-right`}>現價</th>
                <th className={`${th} text-right`}>名目價值</th>
                <th className={`${th} text-right`}>未實現損益</th>
                <th className={`${th} text-right`}>報酬率</th>
                <th className={`${th} text-right`}>槓桿</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {a.positions.map((fp) => (
                <tr key={fp.id} className={tr}>
                  <td className={td}>
                    <div className="flex items-center gap-2">
                      <SideBadge side={fp.side} />
                      <span className="text-fg">{fp.symbol}USDT</span>
                      {fp.note && <span className="text-[12px] text-fg-4">{fp.note}</span>}
                    </div>
                  </td>
                  <td className={`${td} num text-right`}>{fmtNum(fp.quantity, 8)}</td>
                  <td className={`${td} num text-right text-fg-3`}>{fmtPrice(fp.entry_price)}</td>
                  <td className={`${td} num text-right`}>{fmtPrice(fp.markUsdt)}</td>
                  <td className={`${td} num text-right`}>{fmtUsdt(fp.notionalUsdt)}</td>
                  <td className={`${td} text-right`}>
                    <Delta value={fp.upnlUsdt} format={fmtUsdt} />
                  </td>
                  <td className={`${td} text-right`} title={fp.leverage ? "以初始保證金計 (ROE)" : "價格變動幅度（未填槓桿）"}>
                    <Delta pct={fp.returnPct} showValue={false} />
                  </td>
                  <td className={`${td} num text-right text-fg-3`}>{fp.leverage ? `${fmtNum(fp.leverage, 2)}x` : "—"}</td>
                  <td className={`${td} w-px text-right`}>
                    <FuturesPositionForm accountId={a.id} item={fp} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function CryptoPage() {
  const p = getPortfolio();
  const t = p.totals;
  const rows = [...p.crypto].sort((a, b) => b.position.valueTwd - a.position.valueTwd);
  const cost = rows.reduce((a, r) => a + (r.position.costTwd ?? 0), 0);
  const valueWithCost = rows.filter((r) => r.position.costTwd != null).reduce((a, r) => a + r.position.valueTwd, 0);
  const pnl = valueWithCost - cost;
  const day = [...p.crypto, ...p.futures].reduce((a, r) => a + (r.position.dayChangeTwd ?? 0), 0);
  const futuresUpnlUsdt = p.futures.reduce((a, f) => a + f.upnlUsdt, 0);
  const hasFutures = p.futures.length > 0;

  return (
    <>
      <PageHeader title="加密貨幣">
        <RefreshBar lastPriceAt={p.lastPriceAt} />
      </PageHeader>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-6 md:px-6">
        <SummaryStrip
          items={[
            {
              label: "加密貨幣淨值",
              value: fmtTwd(t.crypto),
              sub: hasFutures ? `現貨 ${fmtTwd(t.cryptoSpot)} · 合約權益 ${fmtTwd(t.cryptoFutures)}` : undefined,
            },
            { label: "24h 變動", value: <Delta value={day} pct={t.crypto ? (day / (t.crypto - day)) * 100 : null} /> },
            { label: "現貨未實現損益", value: cost ? <Delta value={pnl} pct={(pnl / cost) * 100} /> : "—", sub: "僅計有填成本的部位" },
            {
              label: "合約未實現損益",
              value: hasFutures ? <Delta value={futuresUpnlUsdt * (p.usdtTwd ?? 0)} /> : "—",
              sub: hasFutures ? `${fmtUsdt(futuresUpnlUsdt)} USDT` : "尚無合約帳戶",
            },
          ]}
        />

        {/* Spot */}
        <Card className="overflow-hidden">
          <CardHeader title="現貨" right={<CryptoForm />} />
          {rows.length === 0 ? (
            <Empty>尚未新增現貨。點「新增現貨」輸入幣種與數量。</Empty>
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
                        <td className={`${td} num text-right text-fg-3`}>{t.crypto ? fmtPct((pos.valueTwd / t.crypto) * 100, false) : "—"}</td>
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

        {/* Futures */}
        <div className="mt-2 flex items-center justify-between px-1">
          <h2 className="text-[12px] font-medium text-fg-2">
            合約 <span className="font-normal text-fg-4">· U 本位，權益（錢包餘額＋未實現損益）計入淨資產</span>
          </h2>
          <FuturesAccountForm />
        </div>
        {hasFutures ? (
          p.futures.map((a) => <FuturesAccountCard key={a.id} a={a} usdtTwd={p.usdtTwd} />)
        ) : (
          <Card>
            <Empty>沒有合約帳戶。點「新增合約帳戶」填入錢包餘額，再新增部位。</Empty>
          </Card>
        )}

        {/* Net exposure */}
        {hasFutures && p.exposure.length > 0 && (
          <Card className="overflow-hidden">
            <CardHeader title="淨曝險（現貨＋合約）" right={<span className="text-[12px] text-fg-4">正數為淨多、負數為淨空</span>} />
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>幣種</th>
                    <th className={`${th} text-right`}>現貨</th>
                    <th className={`${th} text-right`}>合約淨部位</th>
                    <th className={`${th} text-right`}>淨曝險</th>
                    <th className={`${th} text-right`}>淨曝險市值</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {p.exposure.map((e) => {
                    const gross = Math.abs(e.spotQty) + Math.abs(e.futuresQty);
                    const hedged = gross > 0 && Math.abs(e.netQty) / gross < 0.05;
                    return (
                      <tr key={e.coinId} className={tr}>
                        <td className={`${td} text-fg`}>{e.symbol}</td>
                        <td className={`${td} num text-right text-fg-2`}>{fmtNum(e.spotQty, 8)}</td>
                        <td className={`${td} num text-right text-fg-2`}>
                          {e.futuresQty > 0 ? "+" : ""}
                          {fmtNum(e.futuresQty, 8)}
                        </td>
                        <td className={`${td} num text-right text-fg`}>
                          {e.netQty > 0 ? "+" : ""}
                          {fmtNum(e.netQty, 8)}
                        </td>
                        <td className={`${td} num text-right`}>{fmtTwd(e.netValueTwd)}</td>
                        <td className={`${td} w-px text-right`}>
                          {hedged ? <Badge>已對沖</Badge> : e.netQty < 0 ? <Badge>淨空</Badge> : <Badge>淨多</Badge>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
