const twd = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });

export function fmtTwd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n < 0 ? "-" : ""}NT$${twd.format(Math.abs(Math.round(n)))}`;
}

/** Compact form for chart axes: 1,234,567 → 123.5萬, 120,000,000 → 1.2億 */
export function fmtCompact(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(a >= 1e9 ? 0 : 1)}億`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(a >= 1e6 ? 0 : 1)}萬`;
  return `${sign}${Math.round(a)}`;
}

export function fmtNum(n: number | null | undefined, maxDigits = 4): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: maxDigits }).format(n);
}

export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const digits = n >= 1000 ? 0 : n >= 1 ? 2 : 6;
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: digits, minimumFractionDigits: n >= 1000 ? 0 : 2 }).format(n);
}

export function fmtPct(n: number | null | undefined, signed = true): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = `${Math.abs(n).toFixed(2)}%`;
  if (!signed) return s;
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
}

/**
 * MM/DD HH:mm:ss in Asia/Taipei (UTC+8, no DST). Hand-rolled so server and browser
 * render byte-identical strings — Intl output differs across ICU builds.
 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
