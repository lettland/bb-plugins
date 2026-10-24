import { describe, expect, it } from "vitest";
import { rowTexts, shellFields } from "./detect-rows.js";
import { siblingWrittenPaths } from "./detect-sibling-writes.js";

const ROOT = "/w";
const toolRow = (toolArgs: unknown) => ({
  kind: "work",
  workKind: "tool",
  status: "completed",
  startedAt: 20_000,
  createdAt: 20_000,
  completedAt: 21_000,
  approvalStatus: null,
  toolName: "write",
  toolArgs,
});

/** Whether a tool called with `toolArgs` names `path`, which a sibling wrote by name: the sibling's credit is withheld. */
function names(toolArgs: unknown, path = "lib/a.ts"): boolean {
  const family = rowTexts([toolRow(toolArgs)] as never, 10_000, { pending: 30_000, unended: 30_000 }, { includeUnapproved: true });
  const sibling = [{ threadId: "sib-1", text: `echo x > "${path}"`, cwd: ROOT }];
  return siblingWrittenPaths([path], sibling, family, ROOT).size === 0;
}

describe("a tool's string argument with whitespace", () => {
  it.each([
    "cd web && npm run format",
    "(cd web && npm run fix)",
    "FOO=1 npm run fix",
    "./scripts/gen.sh --all",
    "pytest -x && ./gen.sh",
    "# comment\nnpm run format",
    "npm install",
  ])("is read as shell, whatever its first word: `%s` names every path", (command) => {
    expect(names({ command })).toBe(true);
    expect(names([command])).toBe(true);
    expect(names({ steps: { run: command } })).toBe(true);
  });

  it("names the paths it mentions, like any other text", () => {
    expect(names({ note: "see lib/a.ts please" })).toBe(true);
    expect(names({ path: "lib/my file.ts" }, "lib/my file.ts")).toBe(true);
  });

  it.each(["see notes", "install the package", "cd web && npm test", "echo hello"])("does not name every path when it is `%s`", (note) => {
    expect(names({ note })).toBe(false);
  });
});

describe("a tool's string argument that is a single token", () => {
  it.each([{ path: "src/a.ts" }, { path: "scripts/gen.sh" }, { path: "./gen.sh" }, { command: "npm" }, ["scripts/gen.sh"]])(
    "only names itself: %j",
    (toolArgs) => {
      expect(names(toolArgs)).toBe(false);
    },
  );

  it("names its own path", () => {
    expect(names({ path: "src/a.ts" }, "src/a.ts")).toBe(true);
  });
});

describe("the shell lines of a tool's arguments", () => {
  it("reads a shell field held in an array or an object, at any depth", () => {
    expect(shellFields([{ command: "npm ci" }])).toEqual(["npm ci"]);
    expect(shellFields({ steps: [{ script: ["bash", "-lc", "npm run codegen"] }] })).toEqual([
      "bash -lc 'npm run codegen'",
    ]);
    expect(shellFields({ command: { nested: {} } })).toEqual([]);
    expect(shellFields({ command: "git status" })).toEqual(["git status"]);
  });
});

describe("a search row's named texts", () => {
  const searchRow = (path: string | null, query: string) => ({
    kind: "work",
    workKind: "search",
    status: "completed",
    startedAt: 20_000,
    createdAt: 20_000,
    completedAt: 21_000,
    approvalStatus: null,
    cmd: null,
    path,
    query,
  });

  it("names the path and the query of a search with one", () => {
    const texts = rowTexts([searchRow("lib/", "a.ts")] as never, 10_000, { pending: 30_000, unended: 30_000 }, { includeUnapproved: true });
    expect(texts).toEqual([
      { text: "lib/", cwd: null, shell: false },
      { text: "a.ts", cwd: null, shell: false },
    ]);
  });

  it("names only the query of a search without a path", () => {
    const texts = rowTexts([searchRow(null, "a.ts")] as never, 10_000, { pending: 30_000, unended: 30_000 }, { includeUnapproved: true });
    expect(texts).toEqual([{ text: "a.ts", cwd: null, shell: false }]);
  });
});
