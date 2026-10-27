import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// A literal "@" + "/" string key never matches; the regex form does. The
// @bb/plugin-sdk* tsconfig paths are types-only and get no alias.
const pluginRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    name: "bb-plugin-triage",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // The jsdom UI tests chain waitFor polls inside vitest's default 5s
    // budget; on a busy shared host they time out while still passing logic
    // (verified: identical content green at low load, default-budget passes
    // at high load, all failures timeout-shaped).
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["server.ts", "app.tsx", "lib/**", "hooks/**", "components/**"],
      reporter: ["text-summary", "lcov"],
      exclude: [
        "node_modules/**",
        "dist/**",
        "**/*.test.{ts,tsx}",
        "tests/**",
        "types/**",
        "vitest.config.ts",
        "vitest.setup.ts",
      ],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
  resolve: {
    alias: [{ find: /^@\//, replacement: pluginRoot }],
  },
});
