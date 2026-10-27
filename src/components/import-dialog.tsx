"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { importBrokerCsv, previewBrokerCsv } from "@/lib/actions";
import { fmtNum, fmtPrice } from "@/lib/format";
import type { ImportPreview, ImportResult } from "@/lib/import";
import { Field, inputCls } from "./form-dialog";

const STATUS: Record<"new" | "imported" | "similar", string> = { new: "新增", imported: "已匯入", similar: "可能已手動記過" };
const th = "h-8 px-3 text-left text-[12px] font-normal text-fg-3 whitespace-nowrap";
const td = "h-9 px-3 whitespace-nowrap";

/** Import a broker's CSV into a stock account: pick the file, check the preview, then write it. */
export function ImportDialog({ accounts, today }: { accounts: string[]; today: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const listId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [account, setAccount] = useState(accounts.length === 1 ? accounts[0] : "");
  const [date, setDate] = useState(today);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [lines, setLines] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const open = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
    ref.current?.showModal();
  };

  const form = () => {
    const fd = new FormData();
    if (file) fd.append("file", file);
    fd.append("account", account);
    fd.append("date", date);
    return fd;
  };

  const runPreview = () =>
    start(async () => {
      setError(null);
      setResult(null);
      const r = await previewBrokerCsv(form());
      if (!r.ok) return setError(r.error);
      setPreview(r.preview);
      setLines(new Set(r.preview.kind === "trades" ? r.preview.rows.filter((x) => x.status === "new").map((x) => x.line) : []));
    });

  const runImport = () =>
    start(async () => {
      if (!preview) return;
      const fd = form();
      fd.append("kind", preview.kind);
      lines.forEach((l) => fd.append("line", String(l)));
      const r = await importBrokerCsv(fd);
      if (!r.ok) return setError(r.error);
      setResult(r.result);
      setPreview(null);
      router.refresh();
    });

  const toggle = (line: number) =>
    setLines((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });

  const diffs = preview?.kind === "holdings" ? preview.rows.filter((r) => r.diff !== 0) : [];

  return (
    <>
      <button type="button" onClick={open} className="inline-flex h-7 items-center rounded-md border border-line-strong px-2.5 text-[12px] text-fg-2 transition-colors hover:bg-hover">
        匯入對帳單
      </button>
      <dialog
        ref={ref}
        className="m-auto w-[min(820px,calc(100vw-32px))] rounded-xl border border-line-strong bg-panel p-0 text-left shadow-2xl"
        onClick={(e) => e.target === ref.current && ref.current?.close()}
      >
        <div className="flex h-11 items-center border-b border-line px-5">
          <h3 className="text-[13px] font-medium">匯入券商 CSV</h3>
        </div>
        <div className="grid grid-cols-1 gap-4 px-5 py-5 sm:grid-cols-3">
          <Field label="券商帳戶">
            <input
              value={account}
              onChange={(e) => {
                setAccount(e.target.value);
                setPreview(null);
              }}
              list={listId}
              placeholder={accounts.length ? "選擇或輸入新帳戶名稱" : "例如 國泰證券"}
              className={inputCls}
            />
            <datalist id={listId}>
              {accounts.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </Field>
          <Field label="檔案" hint="成交明細或庫存，CSV（UTF-8 或 Big5）">
            <input
              type="file"
              accept=".csv,.txt,text/csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
              }}
              className="text-[12px] text-fg-2 file:mr-2 file:h-7 file:rounded-md file:border file:border-line-strong file:bg-panel-2 file:px-2 file:text-[12px] file:text-fg-2"
            />
          </Field>
          <Field label="對帳單日期" hint="庫存檔才用到：哪一天的庫存">
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => {
                setDate(e.target.value);
                setPreview(null);
              }}
              className={`${inputCls} num`}
            />
          </Field>
        </div>

        {preview && (
          <div className="border-t border-line">
            <p className="px-5 py-3 text-[12px] text-fg-3">
              {preview.kind === "trades"
                ? `成交明細 ${preview.rows.length} 筆：勾選的會記進「${preview.account}」，同一筆重複匯入不會重複記。`
                : `${preview.date} 的庫存 ${preview.rows.length} 檔，和帳本不同的 ${diffs.length} 檔會列到「待確認」。`}
              <span className="ml-1 text-fg-4">認出的欄位：{preview.columns.join("、")}</span>
            </p>
            <div className="max-h-[45vh] overflow-auto">
              {preview.kind === "trades" ? (
                <table className="w-full text-[12px]">
                  <thead className="sticky top-0 bg-panel">
                    <tr>
                      <th className={th} />
                      <th className={th}>日期</th>
                      <th className={th}>標的</th>
                      <th className={th}>買賣</th>
                      <th className={`${th} text-right`}>股數</th>
                      <th className={`${th} text-right`}>成交價</th>
                      <th className={`${th} text-right`}>手續費／稅</th>
                      <th className={th}>狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.line} className="border-t border-line">
                        <td className={td}>
                          <input type="checkbox" disabled={r.status === "imported"} checked={lines.has(r.line)} onChange={() => toggle(r.line)} aria-label={`第 ${r.line} 行`} />
                        </td>
                        <td className={`${td} num text-fg-3`}>{r.date}</td>
                        <td className={td}>
                          <span className="num text-fg">{r.symbol}</span> <span className="text-fg-4">{r.name}</span>
                        </td>
                        <td className={td}>{r.side === "buy" ? "買進" : "賣出"}</td>
                        <td className={`${td} num text-right`}>{fmtNum(r.quantity, 0)}</td>
                        <td className={`${td} num text-right`}>{fmtPrice(r.price)}</td>
                        <td className={`${td} num text-right text-fg-3`}>
                          {fmtNum(r.fee, 0)} / {fmtNum(r.tax, 0)}
                        </td>
                        <td className={`${td} ${r.status === "similar" ? "text-warning" : "text-fg-3"}`}>{STATUS[r.status]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="w-full text-[12px]">
                  <thead className="sticky top-0 bg-panel">
                    <tr>
                      <th className={th}>標的</th>
                      <th className={`${th} text-right`}>券商庫存</th>
                      <th className={`${th} text-right`}>帳本</th>
                      <th className={`${th} text-right`}>差異</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.symbol} className="border-t border-line">
                        <td className={td}>
                          <span className="num text-fg">{r.symbol}</span> <span className="text-fg-4">{r.name}</span>
                        </td>
                        <td className={`${td} num text-right`}>{fmtNum(r.quantity, 0)}</td>
                        <td className={`${td} num text-right text-fg-3`}>{fmtNum(r.ledger, 0)}</td>
                        <td className={`${td} num text-right ${r.diff ? "text-warning" : "text-fg-4"}`}>{r.diff ? `${r.diff > 0 ? "+" : ""}${fmtNum(r.diff, 0)}` : "一致"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {preview.errors.length > 0 && (
              <ul className="border-t border-line px-5 py-2 text-[12px] text-warning">
                {preview.errors.slice(0, 8).map((e) => (
                  <li key={e.line}>
                    第 {e.line} 行：{e.message}
                  </li>
                ))}
                {preview.errors.length > 8 && <li>…共 {preview.errors.length} 行略過</li>}
              </ul>
            )}
          </div>
        )}

        {result && (
          <p className="mx-5 mb-3 rounded-md border border-line-strong px-3 py-2 text-[12px] text-fg-2">
            {result.reported != null
              ? result.reported
                ? `${result.reported} 檔和帳本不同，已列在「待確認」。`
                : "庫存和帳本一致。"
              : `已記進 ${result.added} 筆${result.skipped ? `，略過 ${result.skipped} 筆` : ""}。`}
            {result.failed.length > 0 && (
              <span className="mt-1 block text-warning">
                {result.failed
                  .slice(0, 5)
                  .map((f) => `第 ${f.line} 行：${f.message}`)
                  .join("；")}
              </span>
            )}
          </p>
        )}
        {error && <p className="mx-5 mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}

        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={() => ref.current?.close()} className="h-7 rounded-md border border-line-strong px-3 text-[12px] text-fg-2 hover:bg-hover">
              {result ? "完成" : "取消"}
            </button>
            {preview ? (
              <button
                type="button"
                disabled={pending || (preview.kind === "trades" && lines.size === 0)}
                onClick={runImport}
                className="h-7 rounded-md bg-accent px-3 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {pending ? "處理中…" : preview.kind === "trades" ? `匯入 ${lines.size} 筆` : "對帳"}
              </button>
            ) : (
              <button
                type="button"
                disabled={pending || !file || !account.trim()}
                onClick={runPreview}
                className="h-7 rounded-md bg-accent px-3 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {pending ? "讀取中…" : "預覽"}
              </button>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
