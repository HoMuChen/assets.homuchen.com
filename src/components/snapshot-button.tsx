"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { snapshotNow } from "@/lib/actions";
import { IconCamera } from "./icons";

export function SnapshotButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await snapshotNow();
          if (r && !r.ok) alert(r.error);
          router.refresh();
        })
      }
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[12px] text-fg-2 hover:bg-hover disabled:opacity-60"
    >
      <IconCamera width={14} height={14} />
      {pending ? "快照中…" : "立即快照"}
    </button>
  );
}
