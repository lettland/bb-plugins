import { defineConfig } from "vitest/config";

const exclude = ["node_modules/**", "dist/**"];

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["app.tsx", "server.ts", "rpc-contract.ts", "src/**"],
      reporter: ["text-summary", "lcov"],
      exclude: ["node_modules/**", "dist/**", "**/*.test.{ts,tsx}", "vitest.config.ts"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
    projects: [
      {
        test: {
          name: "bb-plugin-model-instructions",
          include: ["**/*.test.ts"],
          exclude: [...exclude, "server.plugin.test.ts", "server.profiles.test.ts", "server.config.test.ts"],
        },
      },
      {
        test: {
          name: "bb-plugin-model-instructions-app",
          include: ["app.test.tsx"],
          exclude,
          environment: "jsdom",
        },
      },
      {
        // Plugin-level tests set HOME, swap node:url and reset modules: one fork per file, files in series.
        test: {
          name: "bb-plugin-model-instructions-server",
          include: ["server.plugin.test.ts", "server.profiles.test.ts", "server.config.test.ts"],
          exclude,
          pool: "forks",
          isolate: true,
          fileParallelism: false,
        },
      },
    ],
  },
});
