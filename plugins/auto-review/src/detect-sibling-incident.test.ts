import { describe, expect, it } from "vitest";
import { siblingWrittenPaths } from "./detect-sibling-writes.js";

/**
 * The shapes of a real incident, with the root and every path replaced by a
 * placeholder: two threads shared one checkout, and one thread's shell edited
 * test files while the reviewing thread and its child ran their own commands.
 */
const ROOT = "/w";

const heredoc = (head: string, ...lines: string[]) => `${head} <<'EOF'\n${lines.join("\n")}\nEOF`;

/** The sibling's commands, as rows carry them: `cwd` is empty. */
const SIBLING = [
  // Reads one file and writes only to scratch space.
  heredoc(
    "python3 -",
    "import re",
    "s = open('lib/i18n/lv.ts').read()",
    "n = re.sub('a', 'b', s)",
    "open('/tmp/x.txt','w').write(n)",
  ),
  // A glob and two literals, edited through a loop variable.
  heredoc(
    "source ~/.nvm/nvm.sh && nvm use >/dev/null && python3 -",
    "import glob",
    "files=glob.glob('tests/ui/*.test.tsx')+['tests/ui/helpers/setup.ts','tests/cli/cli.test.ts']",
    "for f in files:",
    "    s=open(f).read()",
    "    n=s.replace('a','b')",
    "    open(f,'w').write(n)",
  ),
  heredoc("python3 -", "p='tests/ipc/x.test.ts'", "s=open(p).read()", "s=s.replace('a','b')", "open(p,'w').write(s)"),
  heredoc("python3 -", "p='tests/ipc/z.test.ts'", "s=open(p).read()", "s=s.replace('c','d')", "open(p,'w').write(s)"),
  heredoc("python3 -", "p = 'tests/ipc/w.test.ts'", "s = open(p).read()", "s += 'more'", "open(p, 'w').write(s)"),
  heredoc("cat > tests/svc/cache.test.ts", "import { x } from 'y';", "it('works', () => {", "  expect(x).toBe(1);", "});"),
  `sed -i '' "s/a/b/" tests/ipc/y.test.ts`,
  "sed -n '1,40p' tests/ui/helpers/read.ts",
  'grep -rn "foo" tests/ui/helpers',
  "timeout 100 python3 ~/tools/lv.py check /tmp/x.txt",
];

/** What the reviewing thread and its child ran. */
const FAMILY = [
  "bb thread wait thr_abc123; bb thread output thr_abc123",
  "git show abc1234 --stat && git status --short",
  "git log --oneline abc1234..HEAD && git show abc1234 -- tests && bb aislop scan --base abc1234",
  heredoc(
    "python3 -",
    "for p in ['src/ui/fmt.ts','tests/ui/fmt.test.ts','tests/ui/Card.test.tsx']:",
    "    open(p,'w').write('x')",
  ),
  "git status --short && pnpm exec prettier --write src/ui/fmt.ts tests/ui/fmt.test.ts tests/ui/Card.test.tsx" +
    " && pnpm lint 2>&1 | tail -8 && pnpm typecheck && pnpm exec jest tests/ui/fmt.test.ts",
  'pnpm exec jest tests/ui 2>&1 | grep -E "^(FAIL|Tests:)" | sort -u',
  "pnpm test:coverage > /tmp/cov.txt 2>&1; tail -25 /tmp/cov.txt",
  'grep -rn "foo\\|bar" src/ui --include=*.tsx | head -20; bb status',
  `git status --short > /tmp/before.txt; git diff -U3 tests/ui/Card.test.tsx > /tmp/full.patch; ${heredoc(
    "python3 -",
    "import re",
    "text = open('/tmp/full.patch').read()",
    "open('/tmp/mine.patch','w').write(text)",
  )}\ngit apply --cached /tmp/mine.patch`,
  "git reset -q -- src/ui/fmt.ts tests/ui/Card.test.tsx; git status --short",
];

const WRITTEN = [
  "tests/ui/a.test.tsx",
  "tests/ui/b.test.tsx",
  "tests/ui/helpers/setup.ts",
  "tests/cli/cli.test.ts",
  "tests/ipc/x.test.ts",
  "tests/ipc/z.test.ts",
  "tests/ipc/w.test.ts",
  "tests/svc/cache.test.ts",
  "tests/ipc/y.test.ts",
];
/** Edited by both threads: the sibling's glob matches it, and the family names it. */
const SHARED = ["tests/ui/Card.test.tsx"];
const FAMILYS = ["src/ui/fmt.ts", "tests/ui/fmt.test.ts"];
const UNTOUCHED = ["lib/i18n/lv.ts", "tests/ui/helpers/read.ts", "package.json"];

function credit(family: string[]): string[] {
  const texts = SIBLING.map((text) => ({ threadId: "sib-1", text, cwd: "" }));
  const candidates = [...WRITTEN, ...SHARED, ...FAMILYS, ...UNTOUCHED];
  return [...siblingWrittenPaths(candidates, texts, family, ROOT).keys()].sort();
}

describe("the replayed incident", () => {
  it("credits every sibling-written candidate that the family does not name", () => {
    expect(credit(FAMILY)).toEqual([...WRITTEN].sort());
  });

  it("keeps the file both threads edited, the family's own files and what the sibling only read", () => {
    const credited = credit(FAMILY);
    for (const path of [...SHARED, ...FAMILYS, ...UNTOUCHED]) {
      expect(credited).not.toContain(path);
    }
  });

  it("credits the glob's other match once the family stops naming it", () => {
    expect(credit(FAMILY.filter((text) => !text.includes("Card.test.tsx")))).toContain("tests/ui/Card.test.tsx");
  });

  it("credits nothing from the read-only and scratch-space rows alone", () => {
    const quiet = SIBLING.filter((text) => /^(?:sed -n|grep|timeout)|\/tmp\/x\.txt','w'/u.test(text));
    expect(quiet).toHaveLength(4);
    const texts = quiet.map((text) => ({ threadId: "sib-1", text, cwd: "" }));
    expect(siblingWrittenPaths([...UNTOUCHED, ...WRITTEN], texts, [], ROOT).size).toBe(0);
  });
});
