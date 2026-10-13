import { defineConfig } from "vitest/config";

const exclude = ["node_modules/**", "dist/**"];

export default defineConfig({
  test: {
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
