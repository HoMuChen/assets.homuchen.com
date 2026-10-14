export const TZ = "Asia/Taipei";

/** YYYY-MM-DD in Asia/Taipei. */
export function taipeiDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}

/** Taipei wall-clock parts, for market-hours checks. */
export function taipeiParts(d: Date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { weekday: parts.weekday as string, hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** TWSE regular session 09:00–13:30 (plus a few minutes for the closing auction). */
export function isTwMarketOpen(d: Date = new Date()): boolean {
  const { weekday, hour, minute } = taipeiParts(d);
  if (weekday === "Sat" || weekday === "Sun") return false;
  const m = hour * 60 + minute;
  return m >= 9 * 60 && m <= 13 * 60 + 35;
}

/**
 * TAIFEX index futures: day session 08:45–13:45 Mon–Fri, after-hours 15:00–05:00 (Mon evening
 * through Saturday early morning). Holidays aren't modelled; they only cost a few extra syncs.
 */
export function isTwFuturesOpen(d: Date = new Date()): boolean {
  const { weekday, hour, minute } = taipeiParts(d);
  const m = hour * 60 + minute;
  const weekdayOpen = !["Sat", "Sun"].includes(weekday);
  if (weekdayOpen && m >= 8 * 60 + 45 && m <= 13 * 60 + 45) return true;
  if (weekdayOpen && m >= 15 * 60) return true;
  // 00:00–05:00 belongs to the previous evening's session: Tue–Sat mornings.
  return m <= 5 * 60 && !["Sun", "Mon"].includes(weekday);
}
