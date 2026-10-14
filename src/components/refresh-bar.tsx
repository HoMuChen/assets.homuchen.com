"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { refreshNow } from "@/lib/actions";
import { fmtTime } from "@/lib/format";
import { IconRefresh } from "./icons";

const POLL_MS = 30_000;

/**
 * Keeps the page live: asks the server to refresh stale quotes on mount and every
 * 30s while the tab is visible, then re-renders server components with fresh numbers.
 */
export function RefreshBar({ lastPriceAt }: { lastPriceAt: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/refresh", { method: "POST" });
        if (!stopped && res.ok) {
          const body = (await res.json()) as { updated: number; errors: string[] };
          setError(body.errors.length ? body.errors.join("；") : null);
          if (body.updated > 0) router.refresh();
        }
      } catch {
        /* offline; try again next tick */
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="hidden max-w-[320px] truncate text-[12px] text-warning sm:inline" title={error}>
          ⚠ {error}
        </span>
      )}
      <span className="hidden text-[12px] text-fg-4 sm:inline">報價 {fmtTime(lastPriceAt)}</span>
      <button
        type="button"
        onClick={() =>
          startTransition(async () => {
            const r = await refreshNow();
            setError(r && !r.ok ? r.error ?? "更新失敗" : null);
            router.refresh();
          })
        }
        disabled={pending}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[12px] text-fg-2 transition-colors hover:bg-hover disabled:opacity-60"
      >
        <IconRefresh className={pending ? "animate-spin" : ""} width={14} height={14} />
        更新報價
      </button>
    </div>
  );
}
