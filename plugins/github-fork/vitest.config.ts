import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    testTimeout: 15_000,
    name: "bb-plugin-github",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["**/*.{ts,tsx}"],
      reporter: ["text-summary", "lcov"],
      thresholds: { statements: 68, branches: 57, functions: 55, lines: 69 },
      exclude: [
        "node_modules/**",
        "dist/**",
        "coverage/**",
        "**/*.test.{ts,tsx}",
        "**/test-*.ts",
        "**/fixtures.ts",
        "vitest.config.ts",
        "vitest.setup.ts",
        "testing/**",
        "components/ui/**",
        "lib/portal-scope.ts",
        "lib/utils.ts",
      ],
    },
  },
});
