import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "tippy.js": "tippy.js/dist/tippy.esm.js",
    },
  },
  test: {
    silent: "passed-only",
    name: "bb-plugin-tasks",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    testTimeout: 20_000,
    setupFiles: ["./vitest.setup.ts"],
    server: {
      deps: {
        inline: ["@tiptap/extension-bubble-menu"],
      },
    },
    coverage: {
      provider: "v8",
      include: ["**/*.{ts,tsx}"],
      reporter: ["text-summary", "lcov"],
      thresholds: { statements: 82, branches: 76, functions: 80, lines: 84 },
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
