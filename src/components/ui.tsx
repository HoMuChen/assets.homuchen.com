import Link from "next/link";
import type { ReactNode } from "react";
import { fmtPct, fmtTwd } from "@/lib/format";

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center justify-between gap-3 border-b border-line bg-bg/80 px-4 pt-[env(safe-area-inset-top)] backdrop-blur md:px-6">
      <h1 className="text-[13px] font-medium text-fg">{title}</h1>
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-line bg-panel ${className}`}>{children}</section>;
}

export function CardHeader({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-10 items-center justify-between border-b border-line px-4">
      <h2 className="text-[12px] font-medium text-fg-2">{title}</h2>
      {right}
    </div>
  );
}

/** Signed change, e.g. ▲ NT$12,345 (+1.23%). Arrow + sign so meaning never rides on color alone. */
export function Delta({
  value,
  pct,
  className = "",
  showValue = true,
  format = fmtTwd,
}: {
  value?: number | null;
  pct?: number | null;
  className?: string;
  showValue?: boolean;
  /** Formats the absolute value; defaults to TWD. */
  format?: (n: number) => string;
}) {
  const basis = value ?? pct;
  if (basis == null || !Number.isFinite(basis)) return <span className={`text-fg-4 ${className}`}>—</span>;
  const dir = basis > 0 ? "up" : basis < 0 ? "down" : "flat";
  const color = dir === "up" ? "text-up" : dir === "down" ? "text-down" : "text-fg-3";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "";
  return (
    <span className={`num inline-flex items-center gap-1 whitespace-nowrap ${color} ${className}`}>
      {arrow && <span className="text-[0.7em]">{arrow}</span>}
      {showValue && value != null && <span>{format(Math.abs(value))}</span>}
      {pct != null && <span className={showValue && value != null ? "opacity-80" : ""}>{showValue && value != null ? `(${fmtPct(pct)})` : fmtPct(pct)}</span>}
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-4 py-3.5">
      <span className="text-[12px] text-fg-3">{label}</span>
      <span className="num truncate text-[18px] font-medium tracking-tight text-fg">{value}</span>
      {sub && <span className="text-[12px] text-fg-3">{sub}</span>}
    </div>
  );
}

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "warning" }) {
  const cls = tone === "warning" ? "border-warning/30 text-warning" : "border-line-strong text-fg-3";
  return <span className={`inline-flex h-5 shrink-0 items-center rounded border px-1.5 text-[11px] whitespace-nowrap ${cls}`}>{children}</span>;
}

export function CategoryDot({ color }: { color: string }) {
  return <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: color }} />;
}

/** A holding's or cash account's name, linking to its transaction history once it has a ledger account. */
export function HoldingLink({ accountId, asset, children }: { accountId: number | null; asset: string | null; children: ReactNode }) {
  if (accountId == null) return <span>{children}</span>;
  const href = `/transactions?account=${accountId}${asset ? `&asset=${encodeURIComponent(asset)}` : ""}`;
  return (
    <Link href={href} title="查看交易明細" className="decoration-fg-4 underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-[13px] text-fg-3">{children}</div>;
}

export const th = "h-9 px-4 text-left text-[12px] font-normal text-fg-3 whitespace-nowrap";
export const td = "h-11 px-4 whitespace-nowrap";
export const tr = "border-t border-line hover:bg-hover transition-colors";
