import { defineConfig } from "vitest/config";

const exclude = ["node_modules/**", "dist/**"];

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["detect.ts", "profile.ts", "scopes.ts", "server.ts", "setup.ts"],
      reporter: ["text-summary", "lcov"],
      exclude: ["node_modules/**", "dist/**", "**/*.test.ts", "vitest.config.ts"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
    projects: [
      {
        test: {
          name: "bb-plugin-dir-skills",
          include: ["**/*.test.ts"],
          exclude: [...exclude, "server.setup.test.ts"],
        },
      },
      {
        test: {
          name: "bb-plugin-dir-skills-server",
          include: ["server.setup.test.ts"],
          exclude,
          pool: "forks",
          isolate: true,
          fileParallelism: false,
        },
      },
    ],
  },
});
