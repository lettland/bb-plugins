import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["server.ts", "app.tsx", "contract.ts"],
      reporter: ["text-summary", "lcov"],
      thresholds: { statements: 97, branches: 91, functions: 94, lines: 100 },
    },
  },
});
