import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    env: { TZ: "UTC" },
    testTimeout: 30_000,
  },
});
