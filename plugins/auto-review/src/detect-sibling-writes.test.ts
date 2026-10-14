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

    it("for an interpreter script that only reads a file and writes to stdout", () => {
      expect(credited(candidates, "python3 -c \"import sys; sys.stdout.write(open('lib/c.ts').read())\"")).toEqual([]);
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

    it("when the family runs a project-wide fixer that names no path", () => {
      const sed = "sed -i '' 's/a/b/' lib/x.ts";
      expect(credited(["lib/x.ts"], sed, { family: ["npx eslint --fix"] })).toEqual([]);
      expect(credited(["lib/x.ts"], sed, { family: ["npm run format"] })).toEqual([]);
      expect(credited(["lib/x.ts"], sed, { family: ["pnpm test:coverage", "pnpm exec jest lib/react"] })).toEqual([
        "lib/x.ts",
      ]);
    });

    it("does not when the family only runs scripts or tests", () => {
      const family = ["npm run build", "npm test", "pnpm exec vitest", "git status", "cat lib/d.ts"];
      expect(credited(candidates, "echo x > lib/c.ts", { family })).toEqual(["lib/c.ts"]);
    });
  });
});

describe("a sibling's text, strictly", () => {
  const found = ["src/a.ts", "b.ts", "lib/a.test.ts", "report.txt", "notes.md"];
  const limit = 8_192;

  describe("cut at the limit", () => {
    const tail = "cp b.ts src/a.ts.orig";
    // Cut right after `src/a.ts`: a cut word must never become a target.
    const cutAfterTarget = `echo ${"x".repeat(limit - "cp b.ts src/a.ts".length - "echo ; ".length)}; ${tail}`;

    it("drops the command the cut touched", () => {
      expect(cutAfterTarget.slice(0, limit).endsWith("cp b.ts src/a.ts")).toBe(true);
      expect(writeTargets(cutAfterTarget)).toEqual([]);
      expect(credited(found, cutAfterTarget)).toEqual([]);
    });

    it("keeps the commands before it, and one the cut leaves whole", () => {
      expect(writeTargets(`echo x > b.ts; ${cutAfterTarget}`)).toEqual(["b.ts"]);
      const frame = (filler: string) => `echo x > b.ts; echo ${filler}; echo y > notes.md; `;
      const whole = `${frame("x".repeat(limit - frame("").length))}echo z > src/a.ts`;
      expect(whole.slice(0, limit)).toBe(frame("x".repeat(limit - frame("").length)));
      expect(writeTargets(whole)).toEqual(["b.ts", "notes.md"]);
      const open = `echo x > b.ts\n${"echo y\n".repeat(2_000)}`;
      expect(writeTargets(open)).toEqual(["b.ts"]);
    });

    it("drops a heredoc body cut mid-way, and keeps the command that read it", () => {
      const script = "python3 - <<'EOF'\nopen('src/a.ts', 'w').write('x')\n";
      expect(writeTargets(`${script}${"#".repeat(limit)}`)).toEqual([]);
      expect(writeTargets(`cat > notes.md <<'EOF'\n${"y".repeat(limit)}`)).toEqual(["notes.md"]);
      expect(writeTargets(`${script}EOF`)).toEqual(["src/a.ts"]);
    });
  });

  describe("git's directory options", () => {
    it.each([
      "git -C sub checkout -- b.ts",
      "git -C sub restore b.ts",
      "git --git-dir=x/.git restore b.ts",
      "git --git-dir x/.git restore b.ts",
      "git --work-tree=x checkout -- b.ts",
      "git --work-tree x restore b.ts",
    ])("give no targets: `%s`", (text) => {
      expect(writeTargets(text)).toEqual([]);
    });

    it("leave the other options alone", () => {
      expect(writeTargets("git -c core.x=y restore b.ts")).toEqual(["b.ts"]);
      expect(writeTargets("git --no-pager checkout -- b.ts")).toEqual(["b.ts"]);
    });
  });

  describe("perl -i", () => {
    it.each(["perl -pi -e s/a/b/ b.ts", "perl -i.bak -pe s/a/b/ b.ts", "perl -0pi -e s/a/b/ b.ts", "perl -Mstrict -pi -e s/a/b/ b.ts"])(
      "edits in place: `%s`",
      (text) => {
        expect(writeTargets(text)).toEqual(["b.ts"]);
      },
    );

    it.each([
      "perl -Mstrict -ne 'print' src/a.ts",
      "perl -mstrict -ne 'print' src/a.ts",
      "perl -Ilib -ne 'print' src/a.ts",
      "perl -x src/a.ts",
      "perl -ne 'print' src/a.ts",
    ])("does not otherwise: `%s`", (text) => {
      expect(writeTargets(text)).toEqual([]);
      expect(credited(found, text)).toEqual([]);
    });
  });

  describe("comments", () => {
    it("end the words of their line", () => {
      expect(writeTargets("sed -i 's/x/y/' b.ts # see src/a.ts")).toEqual(["b.ts"]);
      expect(writeTargets("# echo x > src/a.ts\necho y > b.ts")).toEqual(["b.ts"]);
      expect(writeTargets("echo x > b.ts # > src/a.ts\necho y > notes.md")).toEqual(["b.ts", "notes.md"]);
    });

    it("do not start inside a word or a quote", () => {
      expect(writeTargets("echo x > a#b.ts")).toEqual(["a#b.ts"]);
      expect(writeTargets("echo '# x' > b.ts; echo \"#y\" > notes.md")).toEqual(["b.ts", "notes.md"]);
    });

    it("do not let a quote in one swallow the lines after it", () => {
      expect(writeTargets("# it's here\necho x > b.ts")).toEqual(["b.ts"]);
    });
  });

  describe("heredoc tags", () => {
    it("read the `<<\\EOF` form, so its body is not run", () => {
      expect(writeTargets("cat <<\\EOF > notes.md\necho hi > src/a.ts\nEOF")).toEqual(["notes.md"]);
      expect(credited(found, "cat <<\\EOF > notes.md\necho hi > src/a.ts\nEOF")).toEqual(["notes.md"]);
    });

    it("do not start inside quotes", () => {
      expect(writeTargets('grep -n "<<EOF" x.sh\necho x > b.ts')).toEqual(["b.ts"]);
      expect(writeTargets("echo '<<EOF' > notes.md\necho x > b.ts")).toEqual(["notes.md", "b.ts"]);
    });
  });

  describe("interpreter scripts", () => {
    it("credit only the literal targets when every write call has one", () => {
      const text = "python3 -c \"import glob; n=len(glob.glob('src/**/*.ts')); open('report.txt','w').write(str(n))\"";
      expect(credited(found, text)).toEqual(["report.txt"]);
      const two = "python3 - <<'EOF'\nopen('b.ts','a').write('x')\nPath('notes.md').write_text('y')\nEOF";
      expect(credited(found, two)).toEqual(["b.ts", "notes.md"]);
      expect(credited(found, "node -e \"require('fs').writeFileSync('report.txt', 'x'); glob('src/**/*.ts')\"")).toEqual([
        "report.txt",
      ]);
    });

    it("keep the literal names and qualifying globs when a write call targets a variable", () => {
      const variable = "python3 - <<'EOF'\np='lib/a.test.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF";
      expect(credited(found, variable)).toEqual(["lib/a.test.ts"]);
      const loop =
        "python3 - <<'EOF'\nimport glob\nfor f in glob.glob('lib/react/*.test.tsx')+['lib/react/helpers/setup.ts']:\n    s=open(f).read()\n    open(f,'w').write(s)\nEOF";
      const loops = ["lib/react/a.test.tsx", "lib/react/helpers/setup.ts", "lib/react/c.ts"];
      expect(credited(loops, loop)).toEqual(["lib/react/a.test.tsx", "lib/react/helpers/setup.ts"]);
    });

    it("keep them too when one write call is literal and another is not", () => {
      const mixed = "python3 - <<'EOF'\np='lib/a.test.ts'\nopen('report.txt','w').write('x')\nopen(p,'w').write('y')\nEOF";
      expect(credited(found, mixed)).toEqual(["lib/a.test.ts", "report.txt"]);
      const concatenated = "python3 -c \"open('src/a.ts' + x, 'w').write('y'); open('b.ts','w')\"";
      expect(credited(found, concatenated)).toEqual(["b.ts", "src/a.ts"]);
    });

    it("credit nothing when the script writes only through a bare `.write(`", () => {
      expect(credited(found, "python3 -c \"import sys; sys.stdout.write('b.ts')\"")).toEqual([]);
      expect(credited(found, "node -e \"process.stdout.write('b.ts')\"")).toEqual([]);
      expect(credited(found, "node -e \"http.createServer((q, res) => res.write('b.ts'))\"")).toEqual([]);
    });
  });
});

describe("where a sibling's shell is", () => {
  const rows = (...items: Array<[string, string?]>) =>
    items.map(([text, cwd]) => ({ threadId: "sib-1", text, cwd: cwd ?? "" }));
  const written = (
    items: Array<{ threadId: string; text: string; cwd: string }>,
    candidates = ["lib/a.ts", "a.ts", "lib/b.ts", "sub/a.ts", "sub/lib/a.ts"],
  ) =>
    [...siblingWrittenPaths(candidates, items, [], ROOT).keys()].sort();

  it("is the checkout root for an empty or null cwd", () => {
    expect(written(rows(["sed -i s/x/y/ lib/a.ts"]))).toEqual(["lib/a.ts"]);
    expect(written([{ threadId: "sib-1", text: "sed -i s/x/y/ lib/a.ts", cwd: null as never }])).toEqual(["lib/a.ts"]);
  });

  it("is lost after a cd elsewhere, so a later row's relative targets credit nothing", () => {
    const earlier = rows(["cd sub && ls"], ["sed -i s/x/y/ a.ts"]);
    expect(written(earlier)).toEqual([]);
    expect(written(rows(["pushd sub"], ["echo x > lib/a.ts"]))).toEqual([]);
    expect(written(rows(["cd .."], ["echo x > lib/a.ts"]))).toEqual([]);
    expect(written(rows(["cd"], ["echo x > lib/a.ts"]))).toEqual([]);
    expect(written(rows(["cd $HOME"], ["echo x > lib/a.ts"]))).toEqual([]);
  });

  it("still credits an absolute target under the checkout while it is lost", () => {
    expect(written(rows(["cd sub"], ["echo x > /w/lib/a.ts"]))).toEqual(["lib/a.ts"]);
    expect(written(rows(["cd sub"], ["echo x > /elsewhere/lib/a.ts"]))).toEqual([]);
  });

  it("is found again only by a cd to the root by an absolute path", () => {
    expect(written(rows(["cd /w"], ["echo x > lib/a.ts"]))).toEqual(["lib/a.ts"]);
    expect(written(rows(["cd sub"], ["cd /w"], ["echo x > lib/a.ts"]))).toEqual(["lib/a.ts"]);
    expect(written(rows(["cd sub && cd .."], ["echo x > lib/a.ts"]))).toEqual([]);
    expect(written(rows(["cd /w/sub"], ["cd .."], ["echo x > lib/a.ts"]))).toEqual([]);
  });

  it("resolves against a row's own absolute cwd whatever came before", () => {
    expect(written(rows(["cd sub"], ["sed -i s/x/y/ a.ts", "/w/lib"]))).toEqual(["lib/a.ts"]);
  });

  it("is tracked per sibling, and a cd inside a text still stops that text", () => {
    const items = [
      { threadId: "sib-2", text: "cd sub", cwd: "" },
      { threadId: "sib-1", text: "echo x > lib/a.ts", cwd: "" },
      { threadId: "sib-2", text: "echo x > lib/b.ts", cwd: "" },
    ];
    expect([...siblingWrittenPaths(["lib/a.ts", "lib/b.ts"], items, [], ROOT)]).toEqual([["lib/a.ts", "sib-1"]]);
    expect(written(rows(["cd /w && echo x > lib/a.ts"]))).toEqual([]);
  });
});
