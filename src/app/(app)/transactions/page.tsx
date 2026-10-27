import Link from "next/link";
import { AccountForm, TransactionForm } from "@/components/forms";
import { SummaryStrip } from "@/components/summary-strip";
import { Badge, Card, CardHeader, Delta, Empty, PageHeader, td, th, tr } from "@/components/ui";
import type { AccountKind, TxType } from "@/lib/db";
import { fmtNum, fmtPrice, fmtTwd } from "@/lib/format";
import { getAccounts, instruments, listTransactions, replay, seriesTx, txCounts } from "@/lib/ledger";
import { getSetting } from "@/lib/settings";
import { taipeiDate } from "@/lib/time";
import { TX_LABEL } from "@/lib/tx";

const KIND_LABEL: Record<AccountKind, string> = { cash: "現金", stock: "股票", crypto: "加密貨幣" };
const LIMIT = 500;

const signed = (n: number, digits = 0) => `${n > 0 ? "+" : ""}${fmtNum(n, digits)}`;

export default async function TransactionsPage(props: PageProps<"/transactions">) {
  const q = await props.searchParams;
  const one = (k: string) => (typeof q[k] === "string" && q[k] !== "" ? (q[k] as string) : undefined);
  const accounts = getAccounts();
  const accountId = Number(one("account")) || undefined;
  const account = accounts.find((a) => a.id === accountId);
  const kind = account ? undefined : (["cash", "stock", "crypto"] as const).find((k) => k === one("kind"));
  const type = (Object.keys(TX_LABEL) as TxType[]).find((t) => t === one("type"));
  const asset = one("asset");
  const rows = listTransactions({ kind, accountId: account?.id, asset, type, limit: LIMIT });

  const today = taipeiDate();
  const formAccounts = (k: "stock" | "crypto") =>
    accounts.filter((a) => a.kind === k).map((a) => ({ name: a.name, feeDiscount: a.fee_discount }));
  const startedAt = getSetting("ledger_started_at");
  const counts = txCounts();

  // One holding's or one cash account's history: show where it stands.
  const series = account && (asset || account.kind === "cash") ? seriesTx(account.id, asset ?? null) : null;
  const state = series && asset ? replay(series) : null;
  const label = asset ? (instruments().get(asset)?.symbol ?? asset) : null;
  const unitDigits = (k: AccountKind) => (k === "crypto" ? 8 : 0);

  return (
    <>
      <PageHeader title="交易紀錄">
        <TransactionForm kind="crypto" accounts={formAccounts("crypto")} today={today} trigger="addSubtle" triggerLabel="加密貨幣" />
        <TransactionForm kind="stock" accounts={formAccounts("stock")} today={today} triggerLabel="股票" />
      </PageHeader>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-6 md:px-6">
        {state && account && (
          <SummaryStrip
            items={[
              { label: `${label} 持有`, value: fmtNum(state.quantity, unitDigits(account.kind)), sub: account.name },
              {
                label: "成本均價",
                value: state.cost != null && state.quantity ? fmtPrice(state.cost / state.quantity) : "—",
                sub: state.cost != null ? `總成本 ${fmtTwd(state.cost)}` : "成本未知",
              },
              { label: "累計已實現損益", value: <Delta value={state.realized.reduce((s, r) => s + r.amount, 0)} /> },
              { label: "累計股利", value: fmtTwd(state.dividends.reduce((s, d) => s + d.amount, 0)) },
            ]}
          />
        )}
        {series && !asset && account && (
          <SummaryStrip
            items={[
              { label: `${account.name} 餘額`, value: `${fmtNum(series.reduce((s, t) => s + t.amount, 0), 2)} ${account.currency}` },
              { label: "紀錄筆數", value: series.length },
              { label: "機構", value: account.institution ?? "—" },
            ]}
          />
        )}

        <Card className="overflow-hidden">
          <form className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-[12px]">
            <select name="account" defaultValue={account?.id ?? ""} className="h-7 rounded-md border border-line-strong bg-panel-2 px-2 text-fg">
              <option value="">所有帳戶</option>
              {(["stock", "crypto", "cash"] as const).map((k) => (
                <optgroup key={k} label={KIND_LABEL[k]}>
                  {accounts
                    .filter((a) => a.kind === k)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            <select name="type" defaultValue={type ?? ""} className="h-7 rounded-md border border-line-strong bg-panel-2 px-2 text-fg">
              <option value="">所有類型</option>
              {(["open", "buy", "sell", "dividend", "adjust"] as const).map((t) => (
                <option key={t} value={t}>
                  {TX_LABEL[t]}
                </option>
              ))}
            </select>
            {kind && <input type="hidden" name="kind" value={kind} />}
            {asset && <input type="hidden" name="asset" value={asset} />}
            <button className="h-7 rounded-md border border-line-strong px-2.5 text-fg-2 hover:bg-hover">篩選</button>
            {(kind || asset) && (
              <span className="flex items-center gap-1 text-fg-3">
                {kind && <Badge>{KIND_LABEL[kind]}</Badge>}
                {asset && <Badge>{label}</Badge>}
              </span>
            )}
            {(account || kind || asset || type) && (
              <Link href="/transactions" className="ml-auto text-fg-3 hover:text-fg">
                清除篩選
              </Link>
            )}
          </form>
          {rows.length === 0 ? (
            <Empty>沒有符合的交易紀錄。</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>日期</th>
                    <th className={th}>帳戶</th>
                    <th className={th}>類型</th>
                    <th className={th}>標的</th>
                    <th className={`${th} text-right`}>數量</th>
                    <th className={`${th} text-right`}>價格</th>
                    <th className={`${th} text-right`}>金額</th>
                    <th className={`${th} text-right`}>手續費／稅</th>
                    <th className={th}>備註</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id} className={tr}>
                      <td className={`${td} num text-fg-3`}>{t.date}</td>
                      <td className={`${td} text-fg-2`}>{t.account_name}</td>
                      <td className={td}>
                        <span className="text-fg">{TX_LABEL[t.type]}</span>
                        {t.source !== "manual" && (
                          <span className="ml-1.5">
                            <Badge>{t.source}</Badge>
                          </span>
                        )}
                      </td>
                      <td className={td}>
                        {t.asset ? (
                          <span>
                            <span className="num text-fg-2">{t.symbol}</span> <span className="text-[12px] text-fg-4">{t.name}</span>
                          </span>
                        ) : (
                          <span className="text-fg-4">餘額</span>
                        )}
                      </td>
                      <td className={`${td} num text-right`}>{t.asset && t.quantity ? signed(t.quantity, unitDigits(t.account_kind)) : "—"}</td>
                      <td className={`${td} num text-right text-fg-3`}>{t.price != null ? fmtPrice(t.price) : "—"}</td>
                      <td className={`${td} num text-right`}>
                        {t.amount ? signed(t.amount, t.account_kind === "cash" ? 2 : 0) : "—"}
                        {t.amount && t.account_currency !== "TWD" ? <span className="ml-1 text-[11px] text-fg-4">{t.account_currency}</span> : null}
                      </td>
                      <td className={`${td} num text-right text-fg-3`}>{t.fee || t.tax ? `${fmtNum(t.fee, 0)} / ${fmtNum(t.tax, 0)}` : "—"}</td>
                      <td className={`${td} max-w-[220px] truncate text-[12px] text-fg-3`} title={t.note ?? undefined}>
                        {t.note}
                      </td>
                      <td className={`${td} w-px text-right`}>
                        {t.account_kind !== "cash" && t.source === "manual" && (
                          <TransactionForm kind={t.account_kind} accounts={formAccounts(t.account_kind)} today={today} item={t} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rows.length === LIMIT && <p className="border-t border-line px-4 py-2.5 text-[12px] text-fg-4">只顯示最近 {LIMIT} 筆，可用篩選縮小範圍。</p>}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="券商與交易所帳戶" right={<span className="text-[12px] text-fg-4">記交易時輸入新名稱會自動建立；現金帳戶在「現金」頁管理</span>} />
          {accounts.filter((a) => a.kind !== "cash").length === 0 ? (
            <Empty>還沒有帳戶。</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={th}>帳戶</th>
                    <th className={th}>類型</th>
                    <th className={`${th} text-right`}>手續費折扣</th>
                    <th className={`${th} text-right`}>交易筆數</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody>
                  {accounts
                    .filter((a) => a.kind !== "cash")
                    .map((a) => (
                      <tr key={a.id} className={tr}>
                        <td className={td}>
                          <Link href={`/transactions?account=${a.id}`} className="text-fg hover:underline">
                            {a.name}
                          </Link>
                          {a.institution && a.institution !== a.name && <span className="ml-2 text-[12px] text-fg-4">{a.institution}</span>}
                        </td>
                        <td className={`${td} text-fg-3`}>{KIND_LABEL[a.kind]}</td>
                        <td className={`${td} num text-right text-fg-3`}>
                          {a.kind !== "stock" ? "—" : a.fee_discount == null ? "無" : `${Math.round(a.fee_discount * 1000) / 100} 折`}
                        </td>
                        <td className={`${td} num text-right text-fg-3`}>{counts.get(a.id) ?? 0}</td>
                        <td className={`${td} w-px text-right`}>
                          <AccountForm item={a} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {startedAt && (
          <p className="px-1 text-[11px] text-fg-4">
            帳本從 {taipeiDate(new Date(startedAt))} 開始：當天的持有與餘額記為「期初」，之前的交易不用補記。
          </p>
        )}
      </div>
    </>
  );
}
