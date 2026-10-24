import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-devkit",
    include: ["**/*.test.{ts,tsx,mts,mjs}"],
    exclude: ["node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      include: ["server.ts", "src/**", "scripts/build-index.mjs"],
      reporter: ["text-summary", "lcov"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
      exclude: ["node_modules/**", "dist/**", "**/*.test.{ts,tsx,mts,mjs}", "**/*.d.mts", "vitest.config.ts"],
    },
  },
});
