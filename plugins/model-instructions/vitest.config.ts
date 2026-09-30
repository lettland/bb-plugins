import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-model-instructions",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["server.ts", "src/**"],
      reporter: ["text-summary", "lcov"],
      exclude: ["node_modules/**", "dist/**", "**/*.test.{ts,tsx}", "vitest.config.ts"],
    },
  },
});
