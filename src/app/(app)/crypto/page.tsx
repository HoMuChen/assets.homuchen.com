import Link from "next/link";
import { FuturesAccountForm, FuturesPositionForm, TransactionForm } from "@/components/forms";
import { RefreshBar } from "@/components/refresh-bar";
import { SummaryStrip } from "@/components/summary-strip";
import { Badge, Card, CardHeader, Delta, Empty, HoldingLink, PageHeader, td, th, tr } from "@/components/ui";
import { bybitConfigured } from "@/lib/bybit";
import { fmtNum, fmtPct, fmtPrice, fmtTime, fmtTwd, fmtUsdt } from "@/lib/format";
import { getAccounts, ledgerFuturesIncome, ledgerIncome } from "@/lib/ledger";
import { liquidationDistance, liquidationThresholds } from "@/lib/monitor";
import { getPortfolio, type FuturesAccountView } from "@/lib/portfolio";
import { taipeiDate } from "@/lib/time";

/** Above this effective leverage the account gets a warning badge. */
const HIGH_LEVERAGE = 10;

function SideBadge({ side }: { side: "long" | "short" }) {
  return side === "long" ? (
    <span className="inline-flex h-5 items-center rounded border border-up/40 px-1.5 text-[11px] text-up">多</span>
  ) : (
    <span className="inline-flex h-5 items-center rounded border border-down/40 px-1.5 text-[11px] text-down">空</span>
  );
}

function MiniStat({ label, sub, children }: { label: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] text-fg-4">{label}</span>
      <span className="num truncate text-[13px] text-fg">{children}</span>
      {sub && <span className="num truncate text-[11px] text-fg-4">{sub}</span>}
    </div>
  );
}

type Thresholds = ReturnType<typeof liquidationThresholds>;

const level = (v: number | null, t: { warning: number; urgent: number }, higherIsWorse: boolean) => {
  if (v == null) return "";
  const worse = (x: number) => (higherIsWorse ? v >= x : v <= x);
  return worse(t.urgent) ? "text-danger" : worse(t.warning) ? "text-warning" : "";
};

function FuturesAccountCard({ a, usdtTwd, bybitAvailable, limits }: { a: FuturesAccountView; usdtTwd: number | null; bybitAvailable: boolean; limits: Thresholds }) {
  const lev = a.effectiveLeverage;
  const synced = a.source === "bybit";
  return (
    <Card className="overflow-hidden">
      <div className="flex h-11 items-center justify-between gap-2 border-b border-line px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-[13px] font-medium">{a.name}</h3>
          <Badge>U 本位</Badge>
          {synced && <Badge>Bybit 同步</Badge>}
          {synced && a.sync_error && <Badge tone="warning">⚠ 同步失敗</Badge>}
          {a.equityUsdt <= 0 && <Badge tone="warning">⚠ 權益 ≤ 0</Badge>}
          {lev != null && lev > HIGH_LEVERAGE && <Badge tone="warning">⚠ 槓桿偏高</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {synced ? (
            <span className="hidden px-2 text-[12px] text-fg-4 sm:inline" title={a.sync_error ?? undefined}>
              同步於 {fmtTime(a.synced_at)}
            </span>
          ) : (
            <FuturesPositionForm accountId={a.id} />
          )}
          <FuturesAccountForm item={a} bybitAvailable={bybitAvailable} />
        </div>
      </div>
      {synced && a.sync_error && <p className="border-b border-line bg-warning/5 px-4 py-2 text-[12px] text-warning">同步失敗：{a.sync_error}</p>}

      <div className={`grid grid-cols-2 gap-4 border-b border-line px-4 py-3 ${synced ? "sm:grid-cols-6" : "sm:grid-cols-5"}`}>
        <MiniStat label="錢包餘額 (USDT)" sub={synced && a.fund_balance ? `含資金帳戶 ${fmtUsdt(a.fund_balance)}` : undefined}>
          {fmtUsdt(a.wallet_balance)}
        </MiniStat>
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
        {synced && (
          <MiniStat label="維持保證金率">
            <span className={level(a.margin_rate, limits.marginRate, true)}>{a.margin_rate != null ? fmtPct(a.margin_rate, false) : "—"}</span>
          </MiniStat>
        )}
      </div>

      {a.positions.length === 0 ? (
        <Empty>{synced ? "目前沒有持倉。" : "尚無部位。點「新增部位」記錄目前持倉。"}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr>
                <th className={th}>合約</th>
                <th className={`${th} text-right`}>數量</th>
                <th className={`${th} text-right`}>開倉均價</th>
                <th className={`${th} text-right`}>{synced ? "標記價" : "現價"}</th>
                <th className={`${th} text-right`}>名目價值</th>
                <th className={`${th} text-right`}>未實現損益</th>
                <th className={`${th} text-right`}>報酬率</th>
                <th className={`${th} text-right`}>槓桿</th>
                {synced && <th className={`${th} text-right`}>強平價</th>}
                {synced && <th className={`${th} text-right`}>距強平</th>}
                {!synced && <th className={th} />}
              </tr>
            </thead>
            <tbody>
              {a.positions.map((fp) => {
                const dist = liquidationDistance(fp);
                return (
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
                    {synced && <td className={`${td} num text-right text-fg-3`}>{fp.liq_price ? fmtPrice(fp.liq_price) : "—"}</td>}
                    {synced && (
                      <td className={`${td} num text-right ${level(dist, limits.distance, false)}`} title="標記價再往不利方向走多少 % 會被強平">
                        {dist != null ? fmtPct(dist, false) : "—"}
                      </td>
                    )}
                    {!synced && (
                      <td className={`${td} w-px text-right`}>
                        <FuturesPositionForm accountId={a.id} item={fp} />
                      </td>
                    )}
                  </tr>
                );
              })}
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
  const today = taipeiDate();
  const accounts = getAccounts("crypto").map((a) => ({ name: a.name, feeDiscount: a.fee_discount }));
  const realized = ledgerIncome("crypto", today.slice(0, 4)).realized;
  const rows = [...p.crypto].sort((a, b) => b.position.valueTwd - a.position.valueTwd);
  const cost = rows.reduce((a, r) => a + (r.position.costTwd ?? 0), 0);
  const valueWithCost = rows.filter((r) => r.position.costTwd != null).reduce((a, r) => a + r.position.valueTwd, 0);
  const pnl = valueWithCost - cost;
  const day = [...p.crypto, ...p.futures].reduce((a, r) => a + (r.position.dayChangeTwd ?? 0), 0);
  const futuresUpnlUsdt = p.futures.reduce((a, f) => a + f.upnlUsdt, 0);
  const hasFutures = p.futures.length > 0;
  const bybitAvailable = bybitConfigured();
  const limits = liquidationThresholds();
  const spotSynced = getAccounts("crypto").some((a) => a.source === "bybit");
  // Realized PnL, trading fees and funding the sync wrote into the ledger this year.
  const futuresIncome = p.futures.some((f) => f.account_id != null) ? ledgerFuturesIncome(today.slice(0, 4)) : null;

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
            {
              label: "現貨未實現損益",
              value: cost ? <Delta value={pnl} pct={(pnl / cost) * 100} /> : "—",
              sub: `${today.slice(0, 4)} 已實現 ${fmtTwd(realized)}`,
            },
            {
              label: "合約未實現損益",
              value: hasFutures ? <Delta value={futuresUpnlUsdt * (p.usdtTwd ?? 0)} /> : "—",
              sub: hasFutures
                ? `${fmtUsdt(futuresUpnlUsdt)} USDT${futuresIncome != null ? ` · ${today.slice(0, 4)} 已實現 ${fmtUsdt(futuresIncome)} USDT` : ""}`
                : "尚無合約帳戶",
            },
          ]}
        />

        {/* Spot */}
        <Card className="overflow-hidden">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                現貨 {spotSynced && <Badge>Bybit 同步</Badge>}
              </span>
            }
            right={
              <div className="flex items-center gap-1">
                <Link href="/transactions?kind=crypto" className="rounded px-2 py-1 text-[12px] text-fg-3 hover:bg-hover hover:text-fg">
                  交易紀錄
                </Link>
                <TransactionForm kind="crypto" accounts={accounts} today={today} trigger="addSubtle" triggerLabel="記一筆" />
              </div>
            }
          />
          {rows.length === 0 ? (
            <Empty>尚未有現貨。點「記一筆」輸入第一筆買進。</Empty>
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
                      <tr key={pos.key} className={tr}>
                        <td className={td}>
                          <div className="flex items-center gap-2">
                            <HoldingLink accountId={r.accountId} asset={r.asset}>
                              <span className="text-fg">{r.symbol.toUpperCase()}</span>
                            </HoldingLink>
                            <span className="text-[12px] text-fg-4">{[r.name, r.account].filter(Boolean).join(" · ")}</span>
                          </div>
                        </td>
                        <td className={`${td} num text-right`}>{fmtNum(r.quantity, 8)}</td>
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
                          <TransactionForm
                            kind="crypto"
                            accounts={accounts}
                            today={today}
                            preset={{ account: r.account, symbol: r.coinId }}
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

        {/* Futures */}
        <div className="mt-2 flex items-center justify-between px-1">
          <h2 className="text-[12px] font-medium text-fg-2">
            合約 <span className="font-normal text-fg-4">· U 本位，權益（錢包餘額＋未實現損益）計入淨資產</span>
          </h2>
          <FuturesAccountForm bybitAvailable={bybitAvailable} />
        </div>
        {hasFutures ? (
          p.futures.map((a) => <FuturesAccountCard key={a.id} a={a} usdtTwd={p.usdtTwd} bybitAvailable={bybitAvailable} limits={limits} />)
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
