"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtCompact, fmtTwd } from "@/lib/format";

export type TrendPoint = {
  date: string;
  netWorth: number;
  stocks: number;
  crypto: number;
  cash: number;
  twFutures: number;
  realEstateEquity: number;
};

const RANGES = [
  { key: "1M", days: 31 },
  { key: "3M", days: 92 },
  { key: "1Y", days: 366 },
  { key: "全部", days: Infinity },
] as const;

function useRange(data: TrendPoint[]) {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("3M");
  const filtered = useMemo(() => {
    const days = RANGES.find((r) => r.key === range)!.days;
    if (!Number.isFinite(days) || data.length === 0) return data;
    // Window ends at the latest snapshot.
    const last = new Date(`${data[data.length - 1].date}T00:00:00Z`).getTime();
    const cutoff = new Date(last - days * 86_400_000).toISOString().slice(0, 10);
    return data.filter((d) => d.date >= cutoff);
  }, [data, range]);
  const tabs = (
    <div className="flex gap-0.5 rounded-md border border-line p-0.5">
      {RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => setRange(r.key)}
          className={`h-5 rounded px-2 text-[11px] transition-colors ${range === r.key ? "bg-hover text-fg" : "text-fg-4 hover:text-fg-2"}`}
        >
          {r.key}
        </button>
      ))}
    </div>
  );
  return { filtered, tabs };
}

const axisTick = { fill: "var(--fg-4)", fontSize: 11 };
const shortDate = (d: string) => d.slice(5).replace("-", "/");

function TooltipBox({
  date,
  rows,
  format = fmtTwd,
}: {
  date: string;
  rows: { label: string; value: number; color?: string }[];
  format?: (n: number) => string;
}) {
  return (
    <div className="min-w-[180px] rounded-md border border-line-strong bg-panel-2 px-3 py-2 shadow-xl">
      <div className="mb-1.5 text-[11px] text-fg-3">{date}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4 text-[12px]">
          <span className="flex items-center gap-1.5 text-fg-2">
            {r.color && <span className="inline-block size-2 rounded-full" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span className="num text-fg">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function NotEnough() {
  return (
    <div className="flex h-full items-center justify-center text-[12px] text-fg-4">
      每天 23:55 自動快照，累積兩天以上就會顯示趨勢
    </div>
  );
}

export function NetWorthChart({ data, title }: { data: TrendPoint[]; title: string }) {
  const { filtered, tabs } = useRange(data);
  return (
    <>
      <div className="flex h-10 items-center justify-between border-b border-line px-4">
        <h2 className="text-[12px] font-medium text-fg-2">{title}</h2>
        {tabs}
      </div>
      <div className="h-[260px] px-2 pb-2 pt-4">
        {filtered.length < 2 ? (
          <NotEnough />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={filtered} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="nw-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={axisTick} axisLine={false} tickLine={false} minTickGap={32} />
              <YAxis
                tickFormatter={fmtCompact}
                tick={axisTick}
                axisLine={false}
                tickLine={false}
                width={56}
                domain={["auto", "auto"]}
              />
              <Tooltip
                cursor={{ stroke: "var(--border-strong)" }}
                content={({ active, payload }) =>
                  active && payload?.[0] ? (
                    <TooltipBox date={payload[0].payload.date} rows={[{ label: "淨資產", value: payload[0].payload.netWorth }]} />
                  ) : null
                }
              />
              <Area
                type="monotone"
                dataKey="netWorth"
                stroke="var(--accent)"
                strokeWidth={2}
                fill="url(#nw-fill)"
                activeDot={{ r: 4, stroke: "var(--panel)", strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </>
  );
}

const STACK = [
  { key: "stocks", label: "股票", color: "var(--series-1)" },
  { key: "crypto", label: "加密貨幣", color: "var(--series-2)" },
  { key: "cash", label: "現金", color: "var(--series-3)" },
  { key: "realEstateEquity", label: "房地產淨值", color: "var(--series-4)" },
  { key: "twFutures", label: "期貨", color: "var(--series-5)" },
] as const;

type SeriesKey = (typeof STACK)[number]["key"];
type ChangePoint = { date: string; netWorth: number } & Record<SeriesKey, number>;

const signedTwd = (n: number) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${fmtTwd(Math.abs(n))}`;
const signedCompact = (n: number) => (n > 0 ? `+${fmtCompact(n)}` : fmtCompact(n));

/** Net-worth history: "變動" (change since the range start, per category) or "組成" (stacked composition). */
export function HistoryChart({ data }: { data: TrendPoint[] }) {
  const { filtered, tabs } = useRange(data);
  const [view, setView] = useState<"change" | "composition">("change");
  const viewTabs = (
    <div className="flex gap-0.5 rounded-md border border-line p-0.5">
      {(
        [
          ["change", "變動"],
          ["composition", "組成"],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => setView(key)}
          className={`h-5 rounded px-2 text-[11px] transition-colors ${view === key ? "bg-hover text-fg" : "text-fg-4 hover:text-fg-2"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
  return (
    <>
      <div className="flex h-10 items-center justify-between gap-2 border-b border-line px-4">
        <h2 className="text-[12px] font-medium text-fg-2">{view === "change" ? "淨資產變動" : "淨資產組成"}</h2>
        <div className="flex items-center gap-2">
          {viewTabs}
          {tabs}
        </div>
      </div>
      {view === "change" ? <ChangeView data={filtered} /> : <CompositionView data={filtered} />}
    </>
  );
}

/**
 * Every category as cumulative TWD change since the first day in range, on one shared axis, plus the
 * net-worth line. A large flat category (real estate) no longer flattens the ones that actually move.
 */
function ChangeView({ data }: { data: TrendPoint[] }) {
  const { points, series, total } = useMemo(() => {
    const base = data[0];
    const points: ChangePoint[] = data.map((p) => ({
      date: p.date,
      netWorth: p.netWorth - (base?.netWorth ?? 0),
      ...(Object.fromEntries(STACK.map((s) => [s.key, p[s.key] - (base?.[s.key] ?? 0)])) as Record<SeriesKey, number>),
    }));
    // Categories that never moved in this range would just be lines lying on zero; leave them out.
    // Colors stay with the category (STACK), so hiding one never repaints the others.
    const series = STACK.filter((s) => points.some((p) => Math.abs(p[s.key]) >= 1));
    return { points, series, total: points.at(-1) };
  }, [data]);

  return (
    <>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3 text-[11px]">
        <span className="flex items-center gap-1.5 text-fg-3">
          <span className="inline-block h-0.5 w-3 rounded-full bg-fg-2" />
          淨資產 <span className="num text-fg-2">{total ? signedTwd(total.netWorth) : "—"}</span>
        </span>
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-fg-3">
            <span className="inline-block size-2 rounded-full" style={{ background: s.color }} />
            {s.label} <span className="num text-fg-2">{total ? signedTwd(total[s.key]) : "—"}</span>
          </span>
        ))}
        {data.length >= 2 && series.length < STACK.length && (
          <span className="text-fg-4">其餘分類期間內沒有變動</span>
        )}
      </div>
      <div className="h-[280px] px-2 pb-2 pt-2">
        {data.length < 2 ? (
          <NotEnough />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={axisTick} axisLine={false} tickLine={false} minTickGap={32} />
              <YAxis tickFormatter={signedCompact} tick={axisTick} axisLine={false} tickLine={false} width={56} />
              <ReferenceLine y={0} stroke="var(--border-strong)" />
              <Tooltip
                cursor={{ stroke: "var(--border-strong)" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.[0]) return null;
                  const p = payload[0].payload as ChangePoint;
                  return (
                    <TooltipBox
                      date={`${p.date} · 較 ${shortDate(data[0].date)}`}
                      rows={[
                        { label: "淨資產", value: p.netWorth },
                        ...series.map((s) => ({ label: s.label, value: p[s.key], color: s.color })),
                      ]}
                      format={signedTwd}
                    />
                  );
                }}
              />
              {series.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, stroke: "var(--panel)", strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              ))}
              <Line
                type="monotone"
                dataKey="netWorth"
                stroke="var(--fg-2)"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4, stroke: "var(--panel)", strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </>
  );
}

function CompositionView({ data }: { data: TrendPoint[] }) {
  return (
    <>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3">
        {STACK.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-fg-3">
            <span className="inline-block size-2 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="h-[280px] px-2 pb-2 pt-2">
        {data.length < 2 ? (
          <NotEnough />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={axisTick} axisLine={false} tickLine={false} minTickGap={32} />
              <YAxis tickFormatter={fmtCompact} tick={axisTick} axisLine={false} tickLine={false} width={56} />
              <Tooltip
                cursor={{ stroke: "var(--border-strong)" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.[0]) return null;
                  const p = payload[0].payload as TrendPoint;
                  return (
                    <TooltipBox
                      date={p.date}
                      rows={[
                        ...STACK.map((s) => ({ label: s.label, value: p[s.key], color: s.color })).reverse(),
                        { label: "淨資產", value: p.netWorth },
                      ]}
                    />
                  );
                }}
              />
              {STACK.map((s) => (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stackId="1"
                  stroke="var(--panel)"
                  strokeWidth={2}
                  fill={s.color}
                  fillOpacity={0.85}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </>
  );
}
