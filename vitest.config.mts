import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    // Production runs with TZ=Asia/Taipei (Dockerfile); mortgage month counting uses local dates.
    env: { TZ: "Asia/Taipei" },
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      reporter: ["text-summary", "text"],
      // The money math, alerting and auth live here; CI fails if coverage slips below this.
      thresholds: { lines: 80, statements: 80 },
    },
  },
});
