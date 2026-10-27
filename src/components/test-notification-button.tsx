"use client";

import { useState, useTransition } from "react";
import { sendTestNotification } from "@/lib/actions";

export function TestNotificationButton({ configured }: { configured: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="flex items-center gap-2">
      {result && <span className={`text-[12px] ${result.ok ? "text-fg-3" : "text-danger"}`}>{result.text}</span>}
      <button
        type="button"
        disabled={pending || !configured}
        title={configured ? undefined : "尚未設定 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID"}
        onClick={() =>
          start(async () => {
            const r = await sendTestNotification();
            setResult(r?.ok ? { ok: true, text: "已送出，請看 Telegram" } : { ok: false, text: r?.error ?? "傳送失敗" });
          })
        }
        className="inline-flex h-7 items-center rounded-md border border-line-strong px-2.5 text-[12px] text-fg-2 hover:bg-hover disabled:opacity-50"
      >
        {pending ? "傳送中…" : "傳送測試訊息"}
      </button>
    </div>
  );
}
