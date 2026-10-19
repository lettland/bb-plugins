import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-wakatime",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["server.ts", "src/**"],
      reporter: ["text-summary", "lcov"],
      exclude: ["node_modules/**", "dist/**", "**/*.test.{ts,tsx}", "vitest.config.ts", "vitest.setup.ts"],
    },
  },
});
