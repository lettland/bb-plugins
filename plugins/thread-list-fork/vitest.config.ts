import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "bb-plugin-thread-list",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["**/*.{ts,tsx}"],
      reporter: ["text-summary", "lcov"],
      thresholds: { statements: 86, branches: 78, functions: 84, lines: 87 },
      exclude: [
        "node_modules/**",
        "dist/**",
        "coverage/**",
        "**/*.test.{ts,tsx}",
        "**/test-*.ts",
        "**/fixtures.ts",
        "vitest.config.ts",
        "vitest.setup.ts",
        "components/ui/**",
        "hooks/useBrowserDimmingModal.ts",
        "lib/portal-scope.ts",
        "lib/utils.ts",
      ],
    },
  },
});
