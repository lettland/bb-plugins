import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-wakatime",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["server.ts", "app.tsx", "src/**"],
      reporter: ["text-summary", "lcov"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
      exclude: ["node_modules/**", "dist/**", "**/*.test.{ts,tsx}", "vitest.config.ts", "vitest.setup.ts"],
    },
  },
});
