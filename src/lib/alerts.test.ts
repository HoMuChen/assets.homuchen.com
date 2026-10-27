import { beforeEach, describe, expect, it } from "vitest";
import { at, mockTelegram, resetDb } from "@/test/helpers";
import { activeAlerts, raiseAlert, resolveAlert, resolveOthers, resolvedSince } from "./alerts";

beforeEach(resetDb);

const T0 = at("2026-10-26 10:00");
const later = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

describe("alerts", () => {
  it("records alerts without Telegram, and sends nothing", async () => {
    await raiseAlert("feed:tw", "warning", "台股報價中斷", "2330", T0);
    expect(activeAlerts()).toMatchObject([{ key: "feed:tw", notified_at: null }]);
  });

  it("notifies once when an alert opens, then stays quiet until the re-notify interval", async () => {
    const tg = mockTelegram();
    await raiseAlert("feed:tw", "warning", "台股報價中斷", "2330 超過 15 分鐘沒有更新", T0);
    await raiseAlert("feed:tw", "warning", "台股報價中斷", "2330、0050 超過 15 分鐘沒有更新", later(5 * MIN));
    expect(tg.texts()).toEqual(["⚠️ 台股報價中斷\n2330 超過 15 分鐘沒有更新"]);
    expect(activeAlerts()[0]).toMatchObject({ detail: "2330、0050 超過 15 分鐘沒有更新", opened_at: T0.toISOString() });

    await raiseAlert("feed:tw", "warning", "台股報價中斷", null, later(12 * 60 * MIN));
    expect(tg.texts()[1]).toBe("⚠️ 仍未解除：台股報價中斷");
  });

  it("re-sends urgent alerts every 30 minutes and on escalation from warning", async () => {
    const tg = mockTelegram();
    await raiseAlert("twfut-risk:1", "warning", "風險指標偏低", "140%", T0);
    await raiseAlert("twfut-risk:1", "urgent", "風險指標偏低", "90%", later(MIN));
    await raiseAlert("twfut-risk:1", "urgent", "風險指標偏低", "88%", later(10 * MIN));
    await raiseAlert("twfut-risk:1", "urgent", "風險指標偏低", "85%", later(31 * MIN));
    expect(tg.texts()).toEqual(["⚠️ 風險指標偏低\n140%", "🚨 風險指標偏低\n90%", "🚨 仍未解除：風險指標偏低\n85%"]);
  });

  it("announces a recovery only when the problem was announced", async () => {
    const tg = mockTelegram();
    await raiseAlert("snapshot", "warning", "超過一天沒有快照", null, T0);
    await resolveAlert("snapshot", later(MIN));
    expect(tg.texts()).toEqual(["⚠️ 超過一天沒有快照", "✅ 已恢復：超過一天沒有快照"]);
    expect(activeAlerts()).toEqual([]);
    expect(resolvedSince(T0)).toHaveLength(1);

    await resolveAlert("snapshot", later(2 * MIN)); // already resolved: nothing more
    expect(tg.texts()).toHaveLength(2);
  });

  it("starts over when a resolved alert opens again", async () => {
    const tg = mockTelegram();
    await raiseAlert("snapshot", "warning", "超過一天沒有快照", null, T0);
    await resolveAlert("snapshot", later(MIN));
    await raiseAlert("snapshot", "warning", "超過一天沒有快照", null, later(2 * MIN));
    expect(tg.texts()).toHaveLength(3);
    expect(activeAlerts()[0].opened_at).toBe(later(2 * MIN).toISOString());
  });

  it("retries a failed send on the next check", async () => {
    mockTelegram(false);
    await raiseAlert("feed:fx", "warning", "外幣匯率中斷", null, T0);
    expect(activeAlerts()[0].notified_at).toBeNull();

    const tg = mockTelegram();
    await raiseAlert("feed:fx", "warning", "外幣匯率中斷", null, later(5 * MIN));
    expect(tg.texts()).toEqual(["⚠️ 外幣匯率中斷"]);
    expect(activeAlerts()[0].notified_at).toBe(later(5 * MIN).toISOString());
  });

  it("silences warnings overnight but never urgent alerts", async () => {
    const tg = mockTelegram();
    await raiseAlert("a", "warning", "a", null, at("2026-10-27 02:00"));
    await raiseAlert("b", "urgent", "b", null, at("2026-10-27 02:00"));
    await raiseAlert("c", "warning", "c", null, at("2026-10-27 08:00"));
    expect(tg.calls.map((c) => (c.body as { disable_notification: boolean }).disable_notification)).toEqual([true, false, false]);
  });

  it("resolveOthers closes alerts under a prefix that are no longer flagged", async () => {
    await raiseAlert("twfut-risk:1", "warning", "a", null, T0);
    await raiseAlert("twfut-risk:2", "warning", "b", null, T0);
    await raiseAlert("feed:tw", "warning", "c", null, T0);
    await resolveOthers("twfut-risk:", new Set(["twfut-risk:2"]), later(MIN));
    expect(activeAlerts().map((a) => a.key).sort()).toEqual(["feed:tw", "twfut-risk:2"]);
  });
});
