import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-dir-skills",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
