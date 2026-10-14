"use client";

import { useActionState } from "react";
import { login } from "@/lib/actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, null);
  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <form action={action} className="flex w-full max-w-[320px] flex-col gap-4">
        <div className="mb-2 flex flex-col items-center gap-3">
          <svg width="36" height="36" viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="8" fill="var(--accent)" />
            <path d="M9 21l5-6 4 3 5-7" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h1 className="text-[15px] font-medium">登入 Assets</h1>
        </div>
        <input
          name="password"
          type="password"
          required
          autoFocus
          autoComplete="current-password"
          placeholder="密碼"
          className="h-9 rounded-md border border-line-strong bg-panel px-3 text-[13px] outline-none placeholder:text-fg-4 focus:border-accent"
        />
        {state && !state.ok && <p className="text-[12px] text-danger">{state.error}</p>}
        <button disabled={pending} className="h-9 rounded-md bg-accent text-[13px] font-medium text-white hover:bg-accent-hover disabled:opacity-60">
          {pending ? "登入中…" : "繼續"}
        </button>
      </form>
    </div>
  );
}
