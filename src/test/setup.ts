import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, vi } from "vitest";

// Each test file gets its own SQLite file; db.ts reads DATA_DIR on first import, so set it before anything loads.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assets-test-"));
process.env.DATA_DIR = dir;

// Start from an unconfigured app regardless of the developer's shell.
for (const k of [
  "APP_PASSWORD",
  "FINMIND_TOKEN",
  "COINGECKO_API_KEY",
  "SINOPAC_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_DIGEST",
  "HEARTBEAT_TOKEN",
  "ALERT_TW_RISK_WARN",
  "ALERT_TW_RISK_URGENT",
  "BYBIT_API_KEY",
  "BYBIT_API_SECRET",
  "BYBIT_BASE_URL",
  "ALERT_LIQ_WARN",
  "ALERT_LIQ_URGENT",
  "ALERT_MMR_WARN",
  "ALERT_MMR_URGENT",
]) {
  delete process.env[k];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => {
  (globalThis as { __assetsDb?: { close(): void } }).__assetsDb?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
