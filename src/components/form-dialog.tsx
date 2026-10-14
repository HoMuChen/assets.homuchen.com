"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { deleteItem, type ActionState } from "@/lib/actions";
import { IconPlus } from "./icons";

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

export const inputCls =
  "h-8 w-full rounded-md border border-line-strong bg-panel-2 px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-4 focus:border-accent";

export function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`flex flex-col gap-1.5 ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-[12px] text-fg-3">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-fg-4">{hint}</span>}
    </label>
  );
}

/**
 * A trigger button + native <dialog> wrapping a server-action form.
 * Closes itself and refreshes on success; shows the action's error otherwise.
 */
export function FormDialog({
  title,
  action,
  children,
  trigger = "add",
  triggerLabel,
  deleteKind,
  deleteId,
}: {
  title: string;
  action: Action;
  children: ReactNode;
  /** add = primary button, addSubtle = secondary button, edit = text link */
  trigger?: "add" | "addSubtle" | "edit";
  triggerLabel?: string;
  deleteKind?: Parameters<typeof deleteItem>[0];
  deleteId?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, null);
  const [deleting, startDelete] = useTransition();
  const [openKey, setOpenKey] = useState(0);
  // Only show an error for a submission made in the currently open dialog.
  const [submittedKey, setSubmittedKey] = useState(-1);

  useEffect(() => {
    if (state?.ok) {
      ref.current?.close();
      router.refresh();
    }
  }, [state, router]);

  const open = () => {
    setOpenKey((k) => k + 1); // remount form so defaults reset each time
    ref.current?.showModal();
  };

  return (
    <>
      {trigger === "add" ? (
        <button
          type="button"
          onClick={open}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-hover"
        >
          <IconPlus width={14} height={14} />
          {triggerLabel ?? "新增"}
        </button>
      ) : trigger === "addSubtle" ? (
        <button
          type="button"
          onClick={open}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-line-strong px-2 text-[12px] text-fg-2 transition-colors hover:bg-hover"
        >
          <IconPlus width={12} height={12} />
          {triggerLabel ?? "新增"}
        </button>
      ) : (
        <button type="button" onClick={open} className="rounded px-2 py-1 text-[12px] text-fg-3 hover:bg-hover hover:text-fg">
          {triggerLabel ?? "編輯"}
        </button>
      )}

      <dialog
        ref={ref}
        className="m-auto w-[min(560px,calc(100vw-32px))] rounded-xl border border-line-strong bg-panel p-0 shadow-2xl"
        onClick={(e) => e.target === ref.current && ref.current?.close()}
      >
        <form key={openKey} ref={formRef} action={formAction} onSubmit={() => setSubmittedKey(openKey)}>
          <div className="flex h-11 items-center border-b border-line px-5">
            <h3 className="text-[13px] font-medium">{title}</h3>
          </div>
          <div className="grid grid-cols-1 gap-4 px-5 py-5 sm:grid-cols-2">{children}</div>
          {state && !state.ok && submittedKey === openKey && (
            <p className="mx-5 mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{state.error}</p>
          )}
          <div className="flex items-center gap-2 border-t border-line px-5 py-3">
            {deleteKind && deleteId != null && (
              <button
                type="button"
                disabled={deleting}
                onClick={() => {
                  if (!confirm("確定要刪除這筆資料嗎？")) return;
                  startDelete(async () => {
                    await deleteItem(deleteKind, deleteId);
                    ref.current?.close();
                    router.refresh();
                  });
                }}
                className="h-7 rounded-md px-2.5 text-[12px] text-danger hover:bg-danger/10 disabled:opacity-60"
              >
                刪除
              </button>
            )}
            <div className="ml-auto flex gap-2">
              <button type="button" onClick={() => ref.current?.close()} className="h-7 rounded-md border border-line-strong px-3 text-[12px] text-fg-2 hover:bg-hover">
                取消
              </button>
              <button type="submit" disabled={pending} className="h-7 rounded-md bg-accent px-3 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-60">
                {pending ? "儲存中…" : "儲存"}
              </button>
            </div>
          </div>
        </form>
      </dialog>
    </>
  );
}
