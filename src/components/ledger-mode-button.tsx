"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setLedgerMode } from "@/lib/actions";

/** Switch every page's holdings to the ledger, or back to the old tables. */
export function LedgerModeButton({ mode, ready }: { mode: "shadow" | "primary"; ready: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const target = mode === "primary" ? "shadow" : "primary";
  const confirmText =
    target === "primary"
      ? "切換後，各頁的持股與現金都改由交易帳本計算。舊資料會繼續同步，隨時可以切回。確定切換？"
      : "切回後，各頁改用舊的持股資料顯示，帳本繼續在背景比對。確定切回？";
  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-[12px] text-danger">{error}</span>}
      <button
        type="button"
        disabled={pending || (target === "primary" && !ready)}
        onClick={() => {
          if (!confirm(confirmText)) return;
          start(async () => {
            const r = await setLedgerMode(target);
            if (r && !r.ok) setError(r.error ?? "切換失敗");
            else router.refresh();
          });
        }}
        className={
          target === "primary"
            ? "inline-flex h-7 items-center rounded-md bg-accent px-2.5 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            : "inline-flex h-7 items-center rounded-md border border-line-strong px-2.5 text-[12px] text-fg-2 hover:bg-hover disabled:opacity-50"
        }
      >
        {pending ? "切換中…" : target === "primary" ? "改用帳本計算" : "切回舊資料"}
      </button>
    </div>
  );
}
