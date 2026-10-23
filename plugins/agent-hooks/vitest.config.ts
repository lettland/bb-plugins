import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-agent-hooks",
    include: ["**/*.test.{ts,tsx,mjs}"],
    exclude: ["node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["server.ts", "src/**", "scripts/checksums.mjs"],
      reporter: ["text-summary", "lcov"],
      exclude: ["node_modules/**", "tests/**", "**/*.test.{ts,tsx,mjs}", "vitest.config.ts"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
