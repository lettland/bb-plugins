import { describe, expect, it } from "vitest";
import { lexCommands } from "./detect-mentions.js";
import { siblingWrittenPaths } from "./detect-sibling-writes.js";

const ROOT = "/w";

/** Whether the family text names `path`, which a sibling wrote by name: the sibling's credit is withheld. */
function names(family: string, path = "lib/a.ts"): boolean {
  const sibling = [{ threadId: "sib-1", text: `echo x > "${path}"`, cwd: ROOT }];
  return siblingWrittenPaths([path], sibling, [family], ROOT).size === 0;
}

describe("a command substitution in a family command", () => {
  it.each(["mv $(git ls-files '*.ts') lib/", "cp $(ls src) lib/", "mv $(git ls-files | head -2) lib/ && git status"])(
    "keeps the command around it whole, so `%s` names its destination",
    (command) => {
      expect(names(command)).toBe(true);
      expect(names(command, "other/a.ts")).toBe(false);
    },
  );

  it("reads the commands inside it on their own, and the outer one with a `$()` word", () => {
    const commands = lexCommands("mv $(git ls-files '*.ts') lib/", 8_192);
    expect(commands.map(({ words }) => words.map(({ text }) => text))).toEqual([["git", "ls-files", "*.ts"], ["mv", "$()", "lib/"]]);
    expect(commands.map(({ depth }) => depth)).toEqual([1, 0]);
  });

  it("does not make a reader a writer", () => {
    expect(names("echo $(ls lib) | wc -l")).toBe(false);
    expect(names("cat $(git ls-files) | wc -l")).toBe(false);
  });

  it("closes a substitution that nests parentheses, or one the text cuts short", () => {
    const nested = lexCommands("echo $((1 + 2)) $(ls (a)) done", 8_192);
    expect(nested.at(-1)?.words.map(({ text }) => text)).toEqual(["echo", "$()", "$()", "done"]);
    expect(lexCommands("mv $(ls lib", 8_192).map(({ words }) => words[0]?.text)).toEqual(["ls", "mv"]);
  });
});

describe("a shell or interpreter that runs a script file", () => {
  it.each([
    "bash -e scripts/gen.sh",
    "sh -e ./gen.sh",
    "bash -euo pipefail x.sh",
    "bash -x -u x.sh",
    "bash -o pipefail x.sh",
    "zsh -e x.sh",
    "dash -e x.sh",
    "node --import tsx scripts/gen.ts",
    "node --require ./setup.js build.js",
    "node -r ts-node/register build.js",
    "node --loader tsx build.mjs",
  ])("`%s` names every path", (command) => {
    expect(names(command)).toBe(true);
  });

  it.each([
    "bash -e",
    "bash -euo pipefail",
    "node --import tsx",
    "node -e 'console.log(1)'",
    "node --require ./setup.js -e 'x'",
    "python -c 'print(1)'",
    "python3 -c 'import os'",
    "ruby -e 'puts 1'",
    "perl -e 'print 1'",
    "bash -c 'ls lib'",
    "bash -e -c 'git status'",
  ])("`%s` is not a script file", (command) => {
    expect(names(command)).toBe(false);
  });

  it.each(["bash -c 'git stash pop'", "bash -ec 'npm install'", "bash -lc 'npm install'", "dash -c 'npm install'", "ksh -c 'npm install'"])(
    "`%s` runs its string as commands",
    (command) => {
      expect(names(command)).toBe(true);
    },
  );
});

describe("python -m", () => {
  it.each([
    "python -m black .",
    "python -m isort .",
    "python3 -m black",
    "python3.12 -m ruff format .",
    "python -m ruff check --fix",
    "python -m autopep8 -i -r .",
    "python -m yapf -i -r .",
    "python -m fix_things",
    "python -m codegen",
    "python -m tools.gen",
  ])("`%s` names every path", (command) => {
    expect(names(command)).toBe(true);
  });

  it.each([
    "python -m pip install requests",
    "python -m pytest",
    "python -m pytest lib/b.test.py",
    "python -m black lib/b.py",
    "python -m ruff check .",
    "python -m venv .venv",
  ])("`%s` does not", (command) => {
    expect(names(command)).toBe(false);
  });
});

describe("package manager options before the script name", () => {
  it.each([
    "pnpm --filter web run format",
    "pnpm --filter=web run format",
    "pnpm -C web fix",
    "pnpm --dir web format",
    "pnpm -r --filter x lint:fix",
    "pnpm -F web codemod",
    "yarn workspace web fix",
    "yarn workspaces foreach run fix",
    "yarn workspaces foreach -A run format",
    "yarn --cwd web fix",
    "npm --prefix web run fix",
    "npm -w web run format",
    "npm --workspace web run format",
    "bun --cwd web run fmt",
    "pnpm --filter web add x",
    "pnpm -C web install",
    "npm --prefix web install",
    "npm -w web install x",
    "yarn workspace web add x",
    "bun --cwd web add x",
  ])("`%s` names every path", (command) => {
    expect(names(command)).toBe(true);
  });

  it.each([
    "pnpm --filter web run build",
    "pnpm -C web test",
    "pnpm -r --filter x lint",
    "yarn workspace web test",
    "yarn workspaces foreach run build",
    "npm --prefix web run lint",
    "npm -w web run test",
    "npm run build -- --fix-nothing-here",
  ])("`%s` does not", (command) => {
    expect(names(command)).toBe(false);
  });
});

describe("more wrappers and commands", () => {
  it.each([
    "uvx ruff format",
    "uvx --from ruff ruff format .",
    "uvx --python 3.12 black",
    "cross-env NODE_ENV=test npm run format",
    "cross-env A=1 B=2 prettier --write",
    "deno fmt",
    "deno fmt .",
    "eval 'npm install'",
    'eval "git stash pop"',
    "eval git checkout main",
    "git submodule update --init",
    "git submodule update",
    "git -C sub submodule update",
  ])("`%s` names every path", (command) => {
    expect(names(command)).toBe(true);
  });

  it.each([
    "uvx ruff check lib/b.ts",
    "cross-env NODE_ENV=test npm test",
    "deno fmt lib/b.ts",
    "deno fmt --check",
    "eval 'git status'",
    "eval 'ls lib'",
    "git submodule status",
    "git submodule foreach pwd",
  ])("`%s` does not", (command) => {
    expect(names(command)).toBe(false);
  });
});
