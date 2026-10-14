import { describe, expect, it } from "vitest";
import { siblingWrittenPaths, writeTargets } from "./detect-sibling-writes.js";

const ROOT = "/w";

function credited(
  candidates: string[],
  text: string,
  options: { cwd?: string | null; family?: string[] } = {},
): string[] {
  const texts = [{ threadId: "sib-1", text, cwd: options.cwd === undefined ? ROOT : options.cwd }];
  return [...siblingWrittenPaths(candidates, texts, options.family ?? [], ROOT).keys()].sort();
}

describe("writeTargets", () => {
  it("names redirect, tee, cp, mv, install, rm, sed -i, checkout and restore targets", () => {
    expect(writeTargets("echo x > a.ts; echo y >> b.ts; echo z 2> c.log")).toEqual(["a.ts", "b.ts", "c.log"]);
    expect(writeTargets("cmd | tee -a d.ts e.ts")).toEqual(["d.ts", "e.ts"]);
    expect(writeTargets("cp -r src f.ts; mv g h.ts; install -m 644 i j.ts")).toEqual(["f.ts", "h.ts", "j.ts"]);
    expect(writeTargets("rm -f k.ts l.ts")).toEqual(["k.ts", "l.ts"]);
    expect(writeTargets("sed -i '' 's/a/b/' m.ts n.ts")).toEqual(["m.ts", "n.ts"]);
    expect(writeTargets("sed -i.bak -e 's/a/b/' o.ts")).toEqual(["o.ts"]);
    expect(writeTargets("perl -pi -e 's/a/b/' p.ts")).toEqual(["p.ts"]);
    expect(writeTargets("git checkout -- q.ts r.ts")).toEqual(["q.ts", "r.ts"]);
    expect(writeTargets("git restore s.ts")).toEqual(["s.ts"]);
    expect(writeTargets("git restore --staged --worktree t.ts")).toEqual(["t.ts"]);
  });

  it("names nothing for reads, scratch targets, content-neutral commands and unresolvable words", () => {
    expect(writeTargets("sed -n 1,10p a.ts")).toEqual([]);
    expect(writeTargets("cat a.ts > /tmp/x; cat a.ts > /dev/null; echo > $TMPDIR/x; echo > ${TMPDIR}/x")).toEqual([]);
    expect(writeTargets("cp a.ts /tmp/bak; cp -t /tmp a.ts; mv --target-directory=/tmp a.ts")).toEqual([]);
    expect(writeTargets("rg '=>' a.ts; touch a.ts; git restore --staged a.ts; git checkout main")).toEqual([]);
    expect(writeTargets("cmd 2>&1 | tee /tmp/log; cmd 2>/tmp/err.log; echo x >&2")).toEqual([]);
    expect(writeTargets("echo x > $OUT; echo y > out-{a,b}.ts; cp a ~/b")).toEqual([]);
  });

  it("stops at the first cd, pushd or popd", () => {
    expect(writeTargets("echo a > a.ts && cd sub && echo b > b.ts")).toEqual(["a.ts"]);
    expect(writeTargets("pushd sub; echo b > b.ts")).toEqual([]);
    expect(writeTargets("(popd) && echo b > b.ts")).toEqual([]);
  });

  it("reads an interpreter body only when it writes a file", () => {
    const write = "python3 - <<'EOF'\np = 'a.ts'\nopen(p, 'w').write('x')\nEOF";
    expect(writeTargets(write)).toContain("a.ts");
    expect(writeTargets("python3 -c \"open('b.ts', 'a').write('x')\"")).toContain("b.ts");
    expect(writeTargets("node -e \"require('fs').writeFileSync('c.ts', 'x')\"")).toContain("c.ts");
    expect(writeTargets("ruby -e \"puts 'd.ts'\"")).toEqual([]);
    expect(writeTargets("python3 - <<'EOF'\nprint(open('e.ts').read())\nEOF")).toEqual([]);
    expect(writeTargets("cat <<'EOF'\nopen(p, 'w'); f.write(x); a.ts\nEOF")).toEqual([]);
  });

  it("reads only the first 8,192 characters", () => {
    expect(writeTargets(`echo ${"a".repeat(8_190)}\necho x > late.ts`)).toEqual([]);
    expect(writeTargets(`echo x > early.ts\necho ${"a".repeat(8_190)}`)).toEqual(["early.ts"]);
  });
});

describe("siblingWrittenPaths", () => {
  const candidates = ["lib/a.test.ts", "lib/b.ts", "lib/c.ts", "lib/d.ts", "lib/new.ts", "package.json", "p.diff"];

  describe("credits the sibling", () => {
    it("(a) for a script body that opens a path to write", () => {
      const text = "python3 - <<'EOF'\np = 'lib/a.test.ts'\nwith open(p, 'w') as f:\n    f.write('x')\nEOF";
      expect(credited(candidates, text)).toEqual(["lib/a.test.ts"]);
    });

    it("(b) for the heredoc target alone, whatever its body holds", () => {
      const body = "echo x > lib/c.ts\nit's\nimport * as x\n**bold**";
      const after = "sed -n 1p lib/d.ts";
      expect(credited(candidates, `cat > lib/new.ts <<'EOF'\n${body}\nEOF\n${after}`)).toEqual(["lib/new.ts"]);
      expect(credited(candidates, `cat <<EOF > lib/new.ts\n${body}\nEOF\n${after}`)).toEqual(["lib/new.ts"]);
    });

    it("(c) for sed -i with the BSD empty suffix", () => {
      expect(credited(candidates, "sed -i '' 's/a/b/' lib/b.ts")).toEqual(["lib/b.ts"]);
    });

    it("(d) for a script's glob", () => {
      const text =
        "python3 - <<'EOF'\nimport glob\nfor p in glob.glob('lib/react/*.test.tsx'):\n    open(p, 'w').write('')\nEOF";
      const found = ["lib/react/a.test.tsx", "lib/react/b.test.tsx", "lib/other/c.test.tsx", "lib/react/d.ts"];
      expect(credited(found, text)).toEqual(["lib/react/a.test.tsx", "lib/react/b.test.tsx"]);
    });

    it("for a relative token resolved against the row's cwd, and an absolute one under the checkout", () => {
      expect(credited(candidates, "sed -i '' s/a/b/ b.ts", { cwd: "/w/lib" })).toEqual(["lib/b.ts"]);
      expect(credited(candidates, "echo x > ../lib/c.ts", { cwd: "/w/sub" })).toEqual(["lib/c.ts"]);
      expect(credited(candidates, "echo x > /w/lib/c.ts", { cwd: "/elsewhere" })).toEqual(["lib/c.ts"]);
      expect(credited(candidates, "echo x > lib/c.ts", { cwd: null })).toEqual(["lib/c.ts"]);
    });

    it("for the diff file `git diff … > p.diff` writes, not for the file it diffs", () => {
      expect(credited(candidates, "git diff lib/c.ts > p.diff")).toEqual(["p.diff"]);
    });

    it("for a qualifying glob target", () => {
      expect(credited(candidates, "rm lib/*.ts")).toEqual(["lib/a.test.ts", "lib/b.ts", "lib/c.ts", "lib/d.ts", "lib/new.ts"]);
    });

    it("naming the sibling that wrote it, the first one when two did", () => {
      const texts = [
        { threadId: "sib-1", text: "echo x > lib/c.ts", cwd: ROOT },
        { threadId: "sib-2", text: "echo x > lib/c.ts; echo y > lib/d.ts", cwd: ROOT },
      ];
      expect([...siblingWrittenPaths(candidates, texts, [], ROOT)]).toEqual([
        ["lib/c.ts", "sib-1"],
        ["lib/d.ts", "sib-2"],
      ]);
    });
  });

  describe("credits no one", () => {
    it.each([
      ["a read with a range", "sed -n 1,10p lib/c.ts"],
      ["a copy of the file to scratch space", "cat lib/c.ts > /tmp/x"],
      ["a cp out of the checkout", "cp lib/c.ts /tmp/bak"],
      ["a cp with a target directory", "cp -t /tmp lib/c.ts"],
      ["a quoted `=>`", "rg '=>' lib/c.ts"],
      ["a tee to scratch space", "cat lib/c.ts 2>&1 | tee /tmp/log"],
      ["a stderr redirect to scratch space", "cat lib/c.ts 2>/tmp/err.log"],
      ["a redirect to stderr", "cat lib/c.ts >&2"],
      ["a touch", "touch lib/c.ts"],
      ["a staged-only restore", "git restore --staged lib/c.ts"],
      ["a bare `*`", "sed -i '' s/a/b/ *"],
      ["a bare `**`", "rm **"],
      ["a glob with no directory", "rm *.json"],
      ["a glob with no literal in its last segment", "rm lib/*"],
      ["a token after a cd", "cd sub && sed -i '' s/a/b/ lib/c.ts"],
      ["a variable", "echo x > $F"],
      ["a path outside the checkout", "echo x > /elsewhere/lib/c.ts"],
      ["a sibling-relative path that leaves the checkout", "echo x > ../lib/c.ts"],
    ])("for %s", (_name, text) => {
      expect(credited(candidates, text)).toEqual([]);
    });

    it("for a write target past character 8,192", () => {
      expect(credited(candidates, `echo ${"a".repeat(8_190)}\necho x > lib/c.ts`)).toEqual([]);
    });

    it("for a pathological glob, and quickly", () => {
      const started = Date.now();
      const text = `rm lib/${"**/".repeat(30)}${"*a".repeat(30)}z.ts`;
      const deep = Array.from({ length: 400 }, (_, i) => `lib/${"a/".repeat(20)}${i}.ts`);
      expect(credited(deep, text)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it("for an interpreter script that writes one file while reading another, only the over-credit is documented", () => {
      // A known limit: every path the script names counts.
      expect(credited(candidates, "python3 -c \"import sys; sys.stdout.write(open('lib/c.ts').read())\"")).toEqual([
        "lib/c.ts",
      ]);
    });
  });

  describe("leaves the path with the family", () => {
    const glob = "python3 - <<'EOF'\nimport glob\nfor p in glob.glob('lib/react/*.test.tsx'):\n    open(p, 'w').write('')\nEOF";
    const found = ["lib/react/a.test.tsx"];

    it("(f) when it runs a writing command over the directory, not a read-only one", () => {
      expect(credited(found, glob, { family: ["jest lib/react"] })).toEqual(found);
      expect(credited(found, glob, { family: ["eslint --fix lib/react"] })).toEqual([]);
      expect(credited(found, glob, { family: ["jest -u lib/react"] })).toEqual([]);
      expect(credited(found, glob, { family: ["cp -r tpl lib/react"] })).toEqual([]);
    });

    it.each([
      ["names it exactly", "cat lib/c.ts"],
      ["names it as a cwd-relative suffix", "cat c.ts"],
      ["names it by an absolute path ending in it", "cat /w/lib/c.ts"],
      ["names it by a matching glob", "wc -l lib/*.ts"],
      ["names it in a tool's arguments", '{"file_path":"/w/lib/c.ts","content":"x"}'],
      ["checks out the tree", "git checkout ."],
      ["pops a stash", "git stash pop"],
      ["installs dependencies", "npm install"],
      ["is a text over 65,536 characters", "x".repeat(65_537)],
    ])("(g, h) when the family %s", (_name, family) => {
      expect(credited(candidates, "echo x > lib/c.ts", { family: [family] })).toEqual([]);
    });

    it("does not for the read-only and index-only commands a replayed incident's family ran", () => {
      const written = ["lib/x/a.test.ts", "lib/react/b.test.tsx", "lib/svc/c.test.ts"];
      const text = "tee lib/x/a.test.ts lib/react/b.test.tsx lib/svc/c.test.ts";
      const family = [
        'grep -rn "foo\\|bar" src/ui --include=*.tsx | head -20; bb status',
        "python3 - <<'EOF'\np='src/util/badge.ts'\nopen(p,'w').write(open(p).read())\n/**\n * Doc\n */\nEOF",
        "git diff -U3 lib/shared.test.tsx > /tmp/p.patch; git apply --cached /tmp/p.patch",
        "git reset -q -- src/a.ts lib/shared.test.tsx; git status --short",
        'pnpm exec jest lib/react 2>&1 | grep -E "^(FAIL|Tests:)" | sort -u',
      ];
      expect(credited(written, text, { family })).toEqual([...written].sort());
    });

    it("does not when the family only runs scripts or tests", () => {
      const family = ["npm run build", "npm test", "pnpm exec vitest", "git status", "cat lib/d.ts"];
      expect(credited(candidates, "echo x > lib/c.ts", { family })).toEqual(["lib/c.ts"]);
    });
  });
});
