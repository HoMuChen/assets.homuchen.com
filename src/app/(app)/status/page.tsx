import type { ReactNode } from "react";
import Link from "next/link";
import { LedgerModeButton } from "@/components/ledger-mode-button";
import { TestNotificationButton } from "@/components/test-notification-button";
import { Card, CardHeader, PageHeader, td, th, tr } from "@/components/ui";
import { SCHEMA_VERSION, type AlertRow, type JobRun } from "@/lib/db";
import { fmtTime } from "@/lib/format";
import { isFailing } from "@/lib/jobs";
import { HEARTBEATS, LEDGER_TRIAL_DAYS } from "@/lib/monitor";
import { getStatus } from "@/lib/status";

type Tone = "ok" | "warning" | "danger" | "idle";

const TONE_DOT: Record<Tone, string> = { ok: "bg-ok", warning: "bg-warning", danger: "bg-danger", idle: "bg-fg-4" };
const TONE_TEXT: Record<Tone, string> = { ok: "text-fg-2", warning: "text-warning", danger: "text-danger", idle: "text-fg-4" };

function Health({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${TONE_TEXT[tone]}`}>
      <span className={`inline-block size-1.5 rounded-full ${TONE_DOT[tone]}`} />
      {children}
    </span>
  );
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (m < 1) return "剛剛";
  if (m < 60) return `${m} 分鐘前`;
  if (m < 48 * 60) return `${Math.round(m / 60)} 小時前`;
  return `${Math.round(m / 1440)} 天前`;
}

function When({ iso, now }: { iso: string | null; now: number }) {
  if (!iso) return <span className="text-fg-4">—</span>;
  return (
    <span className="num text-fg-2">
      {fmtTime(iso)} <span className="text-fg-4">· {ago(iso, now)}</span>
    </span>
  );
}

function ErrorText({ run }: { run: JobRun | null | undefined }) {
  if (!isFailing(run)) return <span className="text-fg-4">—</span>;
  return (
    <span className="block max-w-[360px] truncate text-[12px] text-fg-3" title={run!.last_error ?? ""}>
      {run!.last_error}
    </span>
  );
}

function AlertItem({ a, now }: { a: AlertRow; now: number }) {
  const resolved = a.resolved_at != null;
  return (
    <li className="flex flex-col gap-1 border-t border-line px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <Health tone={resolved ? "idle" : a.level === "urgent" ? "danger" : "warning"}>
          {resolved ? "已恢復" : a.level === "urgent" ? "緊急" : "警示"}
        </Health>
        <span className={resolved ? "text-fg-3" : "text-fg"}>{a.title}</span>
      </div>
      {a.detail && !resolved && <p className="whitespace-pre-line text-[12px] text-fg-3">{a.detail}</p>}
      <p className="text-[11px] text-fg-4">
        {resolved
          ? `${fmtTime(a.opened_at)} → ${fmtTime(a.resolved_at)}`
          : `自 ${fmtTime(a.opened_at)}（${ago(a.opened_at, now)}）· ${a.notified_at ? `已通知 ${fmtTime(a.notified_at)}` : "尚未送出通知"}`}
      </p>
    </li>
  );
}

export default function StatusPage() {
  const { now, alerts, recent, openKeys, runs, feeds, sinopac, bybit, snapshot, monitorFresh, telegram, heartbeats, risk, liquidation, digest, ledger, inbox } =
    getStatus();
  const sinopacRun = runs.get("sync:sinopac");
  const sinopacTone: Tone =
    sinopac.accounts === 0 || !sinopac.configured
      ? "idle"
      : openKeys.has("sync:sinopac")
        ? "danger"
        : sinopac.anyError
          ? "warning"
          : "ok";
  const bybitRun = runs.get("sync:bybit");
  const bybitLinked = (bybit.futures ? 1 : 0) + (bybit.spot ? 1 : 0);
  const bybitTone: Tone =
    bybitLinked === 0 || !bybit.configured
      ? "idle"
      : openKeys.has("sync:bybit")
        ? "danger"
        : isFailing(bybitRun) || bybit.futures?.sync_error
          ? "warning"
          : "ok";
  const monitorRun = runs.get("monitor");

  return (
    <>
      <PageHeader title="系統狀態">
        <TestNotificationButton configured={telegram} />
      </PageHeader>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-6 md:px-6">
        <Card className="overflow-hidden">
          <CardHeader
            title="告警"
            right={<span className="text-[12px] text-fg-4">{alerts.length ? `${alerts.length} 個未解除` : "沒有未解除的告警"}</span>}
          />
          {alerts.length === 0 && recent.length === 0 ? (
            <div className="px-4 py-6">
              <Health tone="ok">一切正常</Health>
            </div>
          ) : (
            <ul>
              {alerts.map((a) => (
                <AlertItem key={a.key} a={a} now={now} />
              ))}
              {recent.map((a) => (
                <AlertItem key={a.key} a={a} now={now} />
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="資料來源" />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  <th className={th}>來源</th>
                  <th className={th}>狀態</th>
                  <th className={`${th} text-right`}>項目</th>
                  <th className={th}>最後更新</th>
                  <th className={th}>最近錯誤</th>
                </tr>
              </thead>
              <tbody>
                {feeds.map((f) => (
                  <tr key={f.key} className={tr}>
                    <td className={td}>
                      <span className="text-fg">{f.label}</span> <span className="text-[12px] text-fg-4">{f.source}</span>
                    </td>
                    <td className={td}>
                      {f.items === 0 ? (
                        <Health tone="idle">未使用</Health>
                      ) : f.stale.length ? (
                        <Health tone="warning">{f.stale.length} 項延遲</Health>
                      ) : isFailing(f.run) ? (
                        <Health tone="warning">上次有錯誤</Health>
                      ) : (
                        <Health tone="ok">正常</Health>
                      )}
                    </td>
                    <td className={`${td} num text-right text-fg-2`}>{f.items}</td>
                    <td className={td}>
                      <When iso={f.newestAt} now={now} />
                    </td>
                    <td className={td}>
                      <ErrorText run={f.run} />
                    </td>
                  </tr>
                ))}
                <tr className={tr}>
                  <td className={td}>
                    <span className="text-fg">永豐期貨同步</span> <span className="text-[12px] text-fg-4">Shioaji sidecar</span>
                  </td>
                  <td className={td}>
                    <Health tone={sinopacTone}>
                      {sinopacTone === "idle"
                        ? sinopac.accounts === 0
                          ? "未使用"
                          : "未設定 SINOPAC_URL"
                        : sinopacTone === "ok"
                          ? "正常"
                          : sinopacTone === "danger"
                            ? "同步失敗"
                            : "上次有錯誤"}
                    </Health>
                  </td>
                  <td className={`${td} num text-right text-fg-2`}>{sinopac.accounts}</td>
                  <td className={td}>
                    <When iso={sinopac.lastSyncAt} now={now} />
                  </td>
                  <td className={td}>
                    <ErrorText run={sinopacRun} />
                  </td>
                </tr>
                <tr className={tr}>
                  <td className={td}>
                    <span className="text-fg">Bybit 同步</span> <span className="text-[12px] text-fg-4">V5 API 唯讀</span>
                  </td>
                  <td className={td}>
                    <Health tone={bybitTone}>
                      {bybitTone === "idle"
                        ? bybitLinked === 0
                          ? "未使用"
                          : "未設定 BYBIT_API_KEY"
                        : bybitTone === "ok"
                          ? "正常"
                          : bybitTone === "danger"
                            ? "同步失敗"
                            : "上次有錯誤"}
                    </Health>
                    {bybit.pendingFills > 0 && <span className="ml-2 text-[12px] text-warning">{bybit.pendingFills} 筆成交待套用</span>}
                  </td>
                  <td className={`${td} num text-right text-fg-2`}>{bybitLinked}</td>
                  <td className={td}>
                    <When iso={bybitRun?.last_ok_at ?? bybit.futures?.synced_at ?? null} now={now} />
                  </td>
                  <td className={td}>
                    <ErrorText run={bybitRun} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="排程與備份" />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  <th className={th}>項目</th>
                  <th className={th}>狀態</th>
                  <th className={th}>最後成功</th>
                  <th className={th}>最近錯誤</th>
                </tr>
              </thead>
              <tbody>
                <tr className={tr}>
                  <td className={td}>
                    <span className="text-fg">每日快照</span> <span className="text-[12px] text-fg-4">23:55</span>
                  </td>
                  <td className={td}>
                    {!snapshot ? (
                      <Health tone="idle">還沒有快照</Health>
                    ) : openKeys.has("snapshot") ? (
                      <Health tone="warning">異常</Health>
                    ) : (
                      <Health tone="ok">{snapshot.date}</Health>
                    )}
                  </td>
                  <td className={td}>
                    <When iso={snapshot?.at ?? null} now={now} />
                  </td>
                  <td className={td}>
                    <ErrorText run={runs.get("snapshot")} />
                  </td>
                </tr>
                <tr className={tr}>
                  <td className={td}>
                    <span className="text-fg">健康檢查</span> <span className="text-[12px] text-fg-4">每 5 分鐘</span>
                  </td>
                  <td className={td}>
                    {monitorFresh ? <Health tone="ok">正常</Health> : <Health tone="warning">沒有在跑</Health>}
                  </td>
                  <td className={td}>
                    <When iso={monitorRun?.last_ok_at ?? null} now={now} />
                  </td>
                  <td className={td}>
                    <ErrorText run={monitorRun} />
                  </td>
                </tr>
                {HEARTBEATS.map((h) => {
                  const run = runs.get(h.job);
                  return (
                    <tr key={h.job} className={tr}>
                      <td className={td}>
                        <span className="text-fg">{h.label}</span>{" "}
                        <span className="text-[12px] text-fg-4">{h.job === "backup" ? "每天 03:30" : "每週日 04:30"}</span>
                      </td>
                      <td className={td}>
                        {!heartbeats ? (
                          <Health tone="idle">未設定 HEARTBEAT_TOKEN</Health>
                        ) : openKeys.has(`heartbeat:${h.job}`) ? (
                          <Health tone="warning">異常</Health>
                        ) : !run ? (
                          <Health tone="idle">尚未回報</Health>
                        ) : (
                          <Health tone="ok">正常</Health>
                        )}
                      </td>
                      <td className={td}>
                        <When iso={run?.last_ok_at ?? null} now={now} />
                      </td>
                      <td className={td}>
                        <ErrorText run={run} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="交易帳本" right={<LedgerModeButton mode={ledger.mode} ready={ledger.ready} />} />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-4 text-[13px] md:grid-cols-3">
            <div className="flex flex-col gap-1">
              <dt className="text-[12px] text-fg-3">各頁持股的來源</dt>
              <dd className="text-fg-2">{ledger.mode === "primary" ? "交易帳本" : "舊資料（帳本在背景比對中）"}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-[12px] text-fg-3">帳本與舊資料比對</dt>
              <dd>
                {ledger.diffs.length ? (
                  <Health tone="warning">{ledger.diffs.length} 筆不一致</Health>
                ) : !ledger.checked ? (
                  <Health tone="idle">等待第一次比對</Health>
                ) : (
                  <Health tone="ok">一致，已連續 {Math.floor(ledger.days)} 天</Health>
                )}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-[12px] text-fg-3">切換條件</dt>
              <dd className="text-fg-2">
                {ledger.mode === "primary"
                  ? "已切換；舊資料仍會同步，可隨時切回"
                  : ledger.ready
                    ? `已連續一致 ${LEDGER_TRIAL_DAYS} 天，可以切換`
                    : `連續一致 ${LEDGER_TRIAL_DAYS} 天後可切換${ledger.agreeing ? `（還要 ${Math.max(1, Math.ceil(LEDGER_TRIAL_DAYS - ledger.days))} 天）` : ""}`}
              </dd>
            </div>
          </dl>
          {ledger.diffs.length > 0 && (
            <ul className="border-t border-line px-4 py-3 text-[12px] text-fg-3">
              {ledger.diffs.slice(0, 20).map((d, i) => (
                <li key={i} className="py-0.5">
                  <span className="text-fg-2">{d.label}</span>：舊 {d.legacy}／帳本 {d.ledger}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {inbox > 0 && (
          <Link
            href="/transactions"
            className="flex items-center gap-2 rounded-lg border border-warning/30 px-4 py-2.5 text-[13px] text-warning transition-colors hover:bg-hover"
          >
            <span className="min-w-0 flex-1 truncate">{inbox} 筆同步或匯入的紀錄等你確認，確認後才會記進帳本</span>
            <span className="shrink-0 text-[12px] text-fg-3">交易紀錄 →</span>
          </Link>
        )}

        <Card>
          <CardHeader title="通知" />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-4 text-[13px] md:grid-cols-3">
            <div className="flex flex-col gap-1">
              <dt className="text-[12px] text-fg-3">Telegram</dt>
              <dd>{telegram ? <Health tone="ok">已設定</Health> : <Health tone="idle">未設定，告警只記在這頁</Health>}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-[12px] text-fg-3">每日摘要（23:55 快照後）</dt>
              <dd className="text-fg-2">{digest === "off" ? "關閉" : digest === "full" ? "含金額" : "只顯示百分比"}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-[12px] text-fg-3">期貨風險指標門檻</dt>
              <dd className="num text-fg-2">
                {risk.warning}% 警示 · {risk.urgent}% 緊急
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-[12px] text-fg-3">Bybit 距強平</dt>
              <dd className="num text-fg-2">
                &lt; {liquidation.distance.warning}% 警示 · &lt; {liquidation.distance.urgent}% 緊急
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-[12px] text-fg-3">Bybit 維持保證金率</dt>
              <dd className="num text-fg-2">
                ≥ {liquidation.marginRate.warning}% 警示 · ≥ {liquidation.marginRate.urgent}% 緊急
              </dd>
            </div>
          </dl>
        </Card>

        <p className="px-1 text-[11px] text-fg-4">
          版本 <span className="num">{process.env.GIT_SHA ?? "dev"}</span> · schema v{SCHEMA_VERSION}
        </p>
      </div>
    </>
  );
}
