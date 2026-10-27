"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { dismissInbox } from "@/lib/actions";

/** Set an inbox item aside without writing anything. */
export function DismissButton({ id }: { id: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await dismissInbox(id);
          if (r && !r.ok) alert(r.error);
          router.refresh();
        })
      }
      className="rounded px-2 py-1 text-[12px] text-fg-4 hover:bg-hover hover:text-fg disabled:opacity-60"
    >
      略過
    </button>
  );
}
