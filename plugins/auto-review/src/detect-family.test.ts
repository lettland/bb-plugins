import { describe, expect, it } from "vitest";
import { familyMatcher } from "./detect-family.js";
import type { Command } from "./detect-mentions.js";

const ROOT = "/w";
const none = () => [];
/** Stands in for the write-target reader: `cp` and `tee` commands write to their last word. */
const targets = ({ words }: Command) =>
  ["cp", "tee"].includes(words[0]?.text ?? "") ? [words[words.length - 1]?.text ?? ""] : [];

const names = (texts: string[], path: string, targetsOf: (command: Command) => string[] = none) =>
  familyMatcher(texts, ROOT, targetsOf)(path);

/** The three paths a sibling wrote in the replayed incident, as placeholders. */
const PROTECTED = ["lib/x/a.test.ts", "lib/react/b.test.tsx", "lib/svc/c.test.ts"];
const named = (texts: string[]) => PROTECTED.filter((path) => names(texts, path));

describe("familyMatcher", () => {
  it("matches an exact token, a `/`-bounded suffix and an absolute path ending in the path", () => {
    expect(names(["cat lib/c.ts"], "lib/c.ts")).toBe(true);
    expect(names(["cat c.ts"], "lib/c.ts")).toBe(true);
    expect(names(["cat react/c.ts"], "lib/react/c.ts")).toBe(true);
    expect(names(["cat ./c.ts"], "lib/c.ts")).toBe(true);
    expect(names(["cat ../lib/c.ts"], "lib/c.ts")).toBe(true);
    expect(names(["cat /elsewhere/lib/c.ts"], "lib/c.ts")).toBe(true);
    expect(names(["cat /w/lib/c.ts:12"], "lib/c.ts")).toBe(true);
    expect(names(["sort < lib/c.ts"], "lib/c.ts")).toBe(true);
    expect(names(["cat ib/c.ts"], "lib/c.ts")).toBe(false);
    expect(names(["cat lib/d.ts"], "lib/c.ts")).toBe(false);
  });

  it("reads a tool's JSON arguments", () => {
    expect(names(['{"file_path":"/w/lib/c.ts"}'], "lib/c.ts")).toBe(true);
    expect(names(['{"file_path":"/w/lib/d.ts","content":"x"}'], "lib/c.ts")).toBe(false);
  });

  it("matches a glob with a `/`, relative or absolute under the root", () => {
    expect(names(["ls lib/react/*.test.tsx"], "lib/react/a.test.tsx")).toBe(true);
    expect(names(["ls /w/lib/**/*.tsx"], "lib/react/a.test.tsx")).toBe(true);
    expect(names(["ls lib/other/*.tsx"], "lib/react/a.test.tsx")).toBe(false);
  });

  describe("a basename glob", () => {
    it("counts only in a command that writes", () => {
      expect(names(['prettier --write "*.test.tsx"'], "lib/react/a.test.tsx")).toBe(true);
      expect(names(["cp tpl *.test.tsx"], "lib/react/a.test.tsx", targets)).toBe(true);
      expect(names(["ls *.test.tsx"], "lib/react/a.test.tsx")).toBe(false);
    });

    it.each(["*", "**", "/**", "*/", "lib/*", "lib/**", "lib/*.*"])("never counts bare `%s`", (glob) => {
      expect(names([`cp tpl ${glob}`], "lib/react/a.test.tsx", targets)).toBe(false);
    });
  });

  describe("a directory", () => {
    it("counts only in the same simple command that writes", () => {
      expect(names(["jest lib/react"], "lib/react/a.ts")).toBe(false);
      expect(names(["eslint --fix lib/react"], "lib/react/a.ts")).toBe(true);
      expect(names(["jest -u lib/react"], "lib/react/a.ts")).toBe(true);
      expect(names(["jest --update-snapshot lib/react"], "lib/react/a.ts")).toBe(true);
      expect(names(["prettier --write lib"], "lib/react/a.ts")).toBe(true);
      expect(names(["cp -r a lib/react"], "lib/react/a.ts", targets)).toBe(true);
      expect(names(["eslint --fix ."], "lib/react/a.ts")).toBe(true);
    });

    it("counts for rm only when recursive", () => {
      expect(names(["rm -rf lib/react"], "lib/react/a.ts")).toBe(true);
      expect(names(["rm -r lib/react"], "lib/react/a.ts")).toBe(true);
      expect(names(["rm lib/react"], "lib/react/a.ts")).toBe(false);
    });

    it("counts for git rm and mv, and not for a read-only git command", () => {
      expect(names(["git rm -r lib/react"], "lib/react/a.ts")).toBe(true);
      expect(names(["git mv lib/react lib/ui"], "lib/react/a.ts")).toBe(true);
      expect(names(["git diff --stat lib/react"], "lib/react/a.ts")).toBe(false);
    });

    it.each(["grep -u x", "rg -w x", "sort -u", "uniq -u", "head -w 1", "wc -w", "ls -w 80", "find . -w", "git log -u"])(
      "does not through the fixer-looking flag of the reader `%s`",
      (reader) => {
        expect(names([`${reader} lib/react`], "lib/react/a.ts")).toBe(false);
      },
    );

    it("counts for find only with -delete or -exec, and then through a fixer flag", () => {
      expect(names(["find lib/react -name x -w"], "lib/react/a.ts")).toBe(false);
      expect(names(["find lib/react -delete -w"], "lib/react/a.ts")).toBe(true);
      expect(names(["find lib/react -exec fmt -w {} +"], "lib/react/a.ts")).toBe(true);
    });
  });

  describe("git", () => {
    it.each([
      "git stash",
      "git -C sub stash pop",
      "git stash push -m x",
      "git merge main",
      "git pull",
      "git rebase main",
      "git cherry-pick abc",
      "git revert abc",
      "git am x.patch",
      "git switch main",
      "git checkout main",
      "git checkout .",
      "git apply x.patch",
      "git apply --index x.patch",
      "git reset --hard",
      "git reset --merge",
      "git reset --keep HEAD~1",
    ])("names every path after `%s`", (command) => {
      expect(names([command], "lib/unrelated.ts")).toBe(true);
    });

    it.each([
      "git stash list",
      "git stash show -p",
      "git checkout -- lib/a.ts",
      "git checkout main -- lib/a.ts",
      "git restore lib/a.ts",
      "git restore --staged lib/a.ts",
      "git rm lib/a.ts",
      "git mv lib/a.ts lib/b.ts",
      "git apply --cached x.patch",
      "git reset",
      "git reset -q -- lib/a.ts lib/b.ts",
      "git reset HEAD~1",
      "git reset --soft HEAD~1",
      "git reset --mixed HEAD~1",
      "git add -A",
      "git commit -m x",
      "git status --short",
      "git diff",
      "git show HEAD",
      "git log --oneline",
    ])("names only its own paths after `%s`", (command) => {
      expect(names([command], "lib/unrelated.ts")).toBe(false);
    });

    it("names the paths a checkout, restore or rm names", () => {
      expect(names(["git checkout -- lib/a.ts"], "lib/a.ts")).toBe(true);
      expect(names(["git restore lib/a.ts"], "lib/a.ts")).toBe(true);
      expect(names(["git rm lib/a.ts"], "lib/a.ts")).toBe(true);
    });

    it("names every path after a checkout of `.`", () => {
      const dot = ({ words }: Command) => (words[0]?.text === "git" ? ["."] : []);
      expect(names(["git checkout -- ."], "lib/unrelated.ts", dot)).toBe(true);
    });
  });

  describe("package managers", () => {
    it.each(["npm install", "pnpm --silent add left-pad", "yarn remove x", "bun update"])(
      "name every path after `%s`",
      (command) => {
        expect(names([command], "lib/unrelated.ts")).toBe(true);
      },
    );

    it.each(["npm run build", "npm test", "pnpm exec vitest", "yarn dlx x"])("do not after `%s`", (command) => {
      expect(names([command], "lib/unrelated.ts")).toBe(false);
    });
  });

  it("takes a text over 65,536 characters as naming every path", () => {
    expect(names(["x".repeat(65_537)], "lib/unrelated.ts")).toBe(true);
    expect(names(["x".repeat(65_536)], "lib/unrelated.ts")).toBe(false);
  });

  it("does not read a git command inside a heredoc body", () => {
    expect(names(["cat > notes.md <<EOF\ngit checkout .\nnpm install\nEOF"], "lib/unrelated.ts")).toBe(false);
  });

  describe("real family texts that must not name an unrelated path", () => {
    it("(1) a recursive grep with a basename glob include", () => {
      const text = 'grep -rn "foo\\|bar" src/ui --include=*.tsx | head -20; bb status';
      expect(named([text])).toEqual([]);
      expect(names([text], "src/ui/x.ts")).toBe(false);
    });

    it("(2) a script heredoc that writes one named file, with a doc comment in its body", () => {
      const text = [
        "python3 - <<'EOF'",
        "p='src/util/badge.ts'",
        "s=open(p).read()",
        "s=s.replace('/**\\n * Old', '/**\\n * New\\n */')",
        "/**",
        " * A doc comment",
        " */",
        "open(p,'w').write(s)",
        "EOF",
      ].join("\n");
      expect(named([text])).toEqual([]);
      expect(names([text], "src/util/badge.ts")).toBe(true);
    });

    it("(3) a partial-staging script that applies a patch to the index only", () => {
      const staged = [
        "git status --short > /tmp/status.txt",
        "git diff -U3 lib/shared.test.tsx > /tmp/shared.patch",
        "python3 - <<'EOF'\nimport re\nparts = re.split(r'^@@', open('/tmp/shared.patch').read())\nEOF",
        "git apply --cached /tmp/shared.patch",
      ].join("\n");
      expect(named([staged])).toEqual([]);
      expect(names([staged], "lib/shared.test.tsx")).toBe(true);
      expect(named([staged.replace("--cached", "--index")])).toEqual(PROTECTED);
      expect(named([staged.replace(" --cached", "")])).toEqual(PROTECTED);
    });

    it("(4) a path reset followed by a status", () => {
      const text = "git reset -q -- src/a.ts src/b.ts lib/shared.test.tsx; git status --short";
      expect(named([text])).toEqual([]);
      expect(names([text], "src/a.ts")).toBe(true);
      expect(named([["git", "reset", "--hard"].join(" ") + "; git status --short"])).toEqual(PROTECTED);
    });

    it("(5) a test run piped to sort -u", () => {
      const text = 'pnpm exec jest lib/react 2>&1 | grep -E "^(FAIL|Tests:)" | sort -u';
      expect(named([text])).toEqual([]);
      expect(names([text], "lib/react/b.test.tsx")).toBe(false);
    });

    it("(6) a longer pipeline ending in a counting grep", () => {
      const text = 'pnpm exec jest lib/react 2>&1 | grep -E "x" | sort -u | grep -ciE "level|badge"';
      expect(named([text])).toEqual([]);
    });

    it("still names the directory when jest itself updates snapshots", () => {
      expect(names(["pnpm exec jest -u lib/react 2>&1 | sort -u"], "lib/react/b.test.tsx")).toBe(true);
    });
  });

  describe("a command that rewrites files without naming them", () => {
    const everyPath = (command: string) => names([command], "lib/unrelated.ts");

    it.each([
      "npx eslint --fix",
      "pnpm exec eslint --fix",
      "jest -u",
      "jest --update-snapshot",
      "prettier --write",
      "prettier --write --log-level warn",
    ])("(1) names every path for a fixer flag with no path: `%s`", (command) => {
      expect(everyPath(command)).toBe(true);
    });

    it.each([
      "eslint --fix lib/react",
      "eslint --fix --ext .ts lib/react",
      "jest -u lib/react",
      "prettier --write lib/a.ts",
      "sort -u",
      "grep -w x",
      "git push -u origin main",
    ])("(1) names only its paths when a fixer flag has paths, or a reader or git runs: `%s`", (command) => {
      expect(everyPath(command)).toBe(false);
    });

    it.each([
      "go fmt",
      "go fmt ./...",
      "gofmt -w",
      "gofmt -w .",
      "cargo fmt",
      "cargo fmt --all",
      "black",
      "black .",
      "isort",
      "isort .",
      "ruff format",
      "ruff format .",
      "ruff check --fix",
    ])("(2) names every path for the whole-tree formatter `%s`", (command) => {
      expect(everyPath(command)).toBe(true);
    });

    it.each([
      "gofmt -w main.go",
      "gofmt main.go",
      "black src/a.py",
      "isort src/a.py",
      "ruff format src/a.py",
      "ruff check src/a.py",
      "go test ./...",
      "go build",
      "cargo test",
    ])("(2) names only its paths for `%s`", (command) => {
      expect(everyPath(command)).toBe(false);
    });

    it.each([
      "npm run lint",
      "npm run format",
      "pnpm run fix",
      "pnpm -r run lint",
      "yarn run codemod",
      "bun run generate",
      "npm run update-snapshots",
      "npm run sync",
      "pnpm lint",
      "yarn prettier",
      "yarn gen",
    ])("(3) names every path for the script `%s`", (command) => {
      expect(everyPath(command)).toBe(true);
    });

    it.each([
      "pnpm test:coverage",
      "pnpm test",
      "pnpm typecheck",
      "pnpm build",
      "yarn build",
      "npm run build",
      "npm run test:coverage",
      "npm run typecheck",
      "pnpm exec jest lib/react",
    ])("(3) does not for the script `%s`", (command) => {
      expect(everyPath(command)).toBe(false);
    });

    it.each(["make", "make lint", "make format", "make generate", "make -C sub fix", "make -j4 sync"])(
      "(4) names every path for `%s`",
      (command) => {
        expect(everyPath(command)).toBe(true);
      },
    );

    it.each(["make test", "make build", "make -C sub test", "make test CC=gcc"])("(4) does not for `%s`", (command) => {
      expect(everyPath(command)).toBe(false);
    });

    it.each([
      "python3 scripts/x.py",
      "python3 -u scripts/x.py",
      "python x.py",
      "node build.js",
      "ruby gen.rb",
      "perl x.pl",
      "bash scripts/x.sh",
      "sh x.sh",
      "./scripts/x.sh",
      "./scripts/x.sh --flag",
      "../tools/fix.sh arg",
      "scripts/x.sh",
    ])("(5) names every path for the script file `%s`", (command) => {
      expect(everyPath(command)).toBe(true);
    });

    it.each(['python3 -c "print(1)"', 'node -e "1"', 'sh -c "ls"', "python3 -m pytest", "node --version", "/usr/bin/env x"])(
      "(5) does not for `%s`",
      (command) => {
        expect(everyPath(command)).toBe(false);
      },
    );

    it("(5) keeps a heredoc script that writes one named file to that file", () => {
      const text = "python3 - <<'EOF'\np='src/util/badge.ts'\nopen(p,'w').write(open(p).read())\nEOF";
      expect(names([text], "src/util/badge.ts")).toBe(true);
      expect(named([text])).toEqual([]);
    });

    it("lets one rewriting command among harmless ones name every path", () => {
      const family = ["pnpm exec jest lib/react 2>&1 | sort -u", "pnpm test:coverage", "git status --short"];
      expect(named(family)).toEqual([]);
      expect(named([...family, "npx eslint --fix"])).toEqual(PROTECTED);
    });
  });
});
