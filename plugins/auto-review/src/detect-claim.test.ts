import { describe, expect, it } from "vitest";
import { classifyRows, resolveClaims, strayCommitReason } from "./detect-claim.js";
import type { RowWrite } from "./detect-claim.js";
import { FAMILY_LOOKBACK_MS } from "./detect-timeline.js";
import { classifyText } from "./detect-claim-shell.js";
import { lexCommands } from "./detect-mentions.js";
import { FIXER_FLAGS, rewritesTree } from "./detect-rewriters.js";
import { unwrap } from "./detect-wrappers.js";

const STARTED_AT = 10_000;
const NOW = 40_000;

/** Every command the classifier takes to write nothing, one per allowlist entry. */
const INERT: string[] = [
  "cd src", "pushd src", "popd", "echo hi", "printf '%s' x", "pwd", "true", "false", "test -f a.ts", "[ -f a.ts ]", "sleep 1",
  "which node", "command -v node", "type git", "export A=1", "set -e", "date",
  "cat a.ts", "head -n 5 a.ts", "tail -f log", "less a.ts", "wc -l a.ts", "ls -la", "grep -rn foo src", "rg foo", "cut -d, -f1 a.csv",
  "tr a b", "sort a.txt", "uniq a.txt", "diff a b", "jq . a.json",
  "sed -n '1,5p' a.ts", "sed 's/x/y/' a.ts", "awk '{print $1}' a.txt", "find . -name '*.ts'",
  "git log --oneline", "git show HEAD", "git diff", "git status", "git grep foo", "git blame a.ts", "git rev-parse HEAD",
  "git ls-files", "git fetch", "git branch", "git branch --show-current", "git branch -a", "git branch -v", "git branch --list",
  "git config --get user.name", "git stash list", "git remote -v", "git add -A", "git commit -m x", "git push",
  "gh pr view 1", "gh issue list", "gh run view 2", "gh pr diff 3", "gh pr checks 4",
  "bb status", "bb guide", "bb thread show thr_1", "bb thread log thr_1", "bb thread output thr_1", "bb thread wait thr_1",
  "bb thread list", "bb thread tell thr_1 hi", "bb auto-review status thr_1", "bb auto-review show",
  "ripwire . --for='x'", "ripwire . --grep=x", "ripwire . --expand=a", "ripwire . --callers=a", "ripwire . --impact=a",
  "ripwire . --uses=a", "ripwire . --exemplar='x'", "ripwire . --pack-task='x'", "ripwire . --plan-lanes=2 --task='x'",
  "ripwire . --from-trace=-", "ripwire . --quality-delta",
  "npm test", "npm run lint", "npm run typecheck", "npm run test:unit", "pnpm test", "yarn lint", "bun test", "vitest run",
  "npx vitest run", "jest lib", "npx jest lib/react", "npm run test -- --ci", "tsc --noEmit", "go test ./...", "cargo test", "pytest",
  "cd x && cat y", "echo ---", "echo x > /tmp/x", "echo x > \"$TMPDIR/x\"", "echo x > /private/tmp/x", "echo x > /dev/null",
  "git rm --cached a.ts", "git rm -r --cached src", "echo x > /var/folders/ab/cd/T/x", "echo x > /private/var/folders/ab/x",
  "while read l; do echo $l; done < a.txt", "read -r line", "sed -n 1p a.ts | while read l; do echo $l; done",
  "timeout 5 cat a.ts", "env A=1 cat a.ts", "bash -lc 'cat a.ts'", "(cat a.ts)", "# a comment\ncat a.ts", "cat <<EOF\nrm -rf a.ts\nEOF",
];

/** Commands that write only what they name, with the names. */
const TARGETED: Array<[string, string[]]> = [
  ["echo x > a.ts", ["a.ts"]],
  ["echo x >> a.ts", ["a.ts"]],
  ["cat in | tee out.ts", ["out.ts"]],
  ["sed -i a.ts", []],
  ["sed -i 's/x/y/' a.ts", ["a.ts"]],
  ["sed -i '' 's/x/y/' a.ts b.ts", ["a.ts", "b.ts"]],
  ["perl -pi -e 's/x/y/' a.ts", ["a.ts"]],
  ["sed -i.bak 's/x/y/' a.ts b.ts", ["a.ts", "b.ts", "a.ts.bak", "b.ts.bak"]],
  ["sed --in-place=.orig 's/x/y/' a.ts", ["a.ts", "a.ts.orig"]],
  ["perl -pi.bak -e 's/x/y/' a.ts", ["a.ts", "a.ts.bak"]],
  ["perl -i.orig -pe 's/x/y/' a.ts", ["a.ts", "a.ts.orig"]],
  ["perl -pi -Ilib -e 's/x/y/' a.ts", ["a.ts"]],
  ["cp a.ts b.ts", ["b.ts", "b.ts/a.ts"]],
  ["cp a.ts src/", ["src", "src/a.ts"]],
  ["cp a.ts b.ts out", ["out", "out/a.ts", "out/b.ts"]],
  ["cp -r a src/", ["src", "src/a"]],
  ["install a.ts b.ts", ["b.ts", "b.ts/a.ts"]],
  ["install -d out/x out/y", ["out/x", "out/y"]],
  ["mv a b", ["a", "b", "b/a"]],
  ["mv a b dir/", ["a", "b", "dir", "dir/a", "dir/b"]],
  ["rm a.ts", ["a.ts"]],
  ["rm -r src/legacy", ["src/legacy"]],
  ["rmdir src/old", ["src/old"]],
  ["git rm a.ts", ["a.ts"]],
  ["git rm -r src/legacy", ["src/legacy"]],
  ["git mv a b", ["a", "b", "b/a"]],
  ["touch a.ts", ["a.ts"]],
  ["mkdir -p out/x", ["out/x"]],
  ["git checkout -- a.ts", ["a.ts"]],
  ["git restore a.ts b.ts", ["a.ts", "b.ts"]],
  ["bash -lc 'sed -i s/x/y/ a.ts'", ["a.ts"]],
  ["timeout 5 rm a.ts", ["a.ts"]],
  ["cat a.ts > b.ts", ["b.ts"]],
  ["cat > a.ts <<'EOF'\nbody\nEOF", ["a.ts"]],
];

/** Commands whose writes cannot be listed. */
const OPAQUE: Array<[string, string]> = [
  ["npm run build", "npm"],
  ["npm run format", "npm"],
  ["npm install", "npm"],
  ["npm test -- -u", "npm"],
  ["ripwire . --replace-symbol-body=x --edit-payload=p", "ripwire"],
  ["ripwire . --html=f", "ripwire"],
  ["ripwire . --for=x --test-gate", "ripwire"],
  ["perl -e 'print 1'", "perl"],
  ["python3 -c \"open('a','w')\"", "python3"],
  ["python3 x.py", "python3"],
  ["node build.js", "node"],
  ["bash run.sh", "bash"],
  ["./scripts/gen.sh", "gen.sh"],
  ["make", "make"],
  ["awk '{print > \"f\"}' a.txt", "awk"],
  ["awk '{print | \"sh\"}'", "awk"],
  ["awk 'BEGIN{system(\"x\")}'", "awk"],
  ["sed 's/x/y/w f' a.ts", "sed"],
  ["sed -i 's/x/y/w f' a.ts", "sed"],
  ["sed -n -f script.sed a.ts", "sed"],
  ["find . -fprint f", "find"],
  ["find . -exec rm {} +", "find"],
  ["find . -delete", "find"],
  ["cp a.ts", "cp"],
  ["cp -t dir a.ts", "cp"],
  ["mv -t dir a.ts", "mv"],
  ["mv a", "mv"],
  ["rm \"$TARGET\"", "rm"],
  ["echo x > \"$OUT\"", "echo"],
  ["echo x > ~/.rc", "echo"],
  ["touch", "touch"],
  ["git checkout -b feat", "git"],
  ["git stash", "git"],
  ["git branch -D x", "git"],
  ["git diff --output=f", "git"],
  ["git restore --staged a.ts", "git"],
  ["vitest -u", "vitest"],
  ["vitest run --update", "vitest"],
  ["tsc", "tsc"],
  ["eslint --fix .", "eslint"],
  ["jest -u", "jest"],
  ["jest --updateSnapshot", "jest"],
  ["sort -o out a.txt", "sort"],
  ["gh pr create", "gh"],
  ["bb aislop scan", "bb"],
  ["some-unknown-tool a", "some-unknown-tool"],
  ["diff <(git show HEAD:a.ts) a.ts", "(process substitution)"],
  ["tee >(cat) a.ts", "(process substitution)"],
  ["echo `rm -rf src`", "echo"],
  ["echo \"$(rm -rf src)\"", "echo"],
  ["eval \"$CMD\"", "eval"],
  ["x".repeat(70_000), "(text over the limit)"],
  ["cat <<EOF\nbody", "(unterminated heredoc)"],
];

/** Scripts and tools run with an option that makes them write what the text does not show. */
const OPAQUE_SCRIPTS: Array<[string, string]> = [
  ["awk -iinplace '{print}' a.txt", "awk"],
  ["awk -i inplace '{print}' a.txt", "awk"],
  ["awk -E prog.awk a.txt", "awk"],
  ["awk --exec prog.awk a.txt", "awk"],
  ["awk -fprog.awk a.txt", "awk"],
  ["awk -f prog.awk a.txt", "awk"],
  ["perl -pi fix.pl a.ts", "perl"],
  ["perl -pi -MFile::Copy -e 's/x/y/' a.ts", "perl"],
  ["perl -pi -Mstrict -e 's/x/y/' a.ts", "perl"],
];

/** Check runs given a flag that makes them rewrite files, write a report or emit. */
const OPAQUE_CHECKS: Array<[string, string]> = [
  ["go test -update ./...", "go"],
  ["go test -update-golden ./...", "go"],
  ["go test ./... -updateGolden", "go"],
  ["pytest --update-snapshots", "pytest"],
  ["pytest --snapshot-update", "pytest"],
  ["vitest run --update-snapshots", "vitest"],
  ["jest --force-regen", "jest"],
  ["jest --update", "jest"],
  ["eslint -o report.txt .", "eslint"],
  ["eslint --output-file r.txt .", "eslint"],
  ["eslint --outputFile=r.json .", "eslint"],
  ["jest --output=r.json", "jest"],
  ["pytest --junitxml=r.xml", "pytest"],
  ["pytest --cov=src", "pytest"],
  ["pytest --cov-report=xml", "pytest"],
  ["vitest run --coverage", "vitest"],
  ["npm test -- --coverage", "npm"],
  ["pyright --createstub pkg", "pyright"],
  ["tsc --noEmit false", "tsc"],
  ["tsc --noEmit --noEmit=false", "tsc"],
  ["npm run tsc", "npm"],
  ["go test -coverprofile=c.out ./...", "go"],
  ["go test -cpuprofile cpu.out", "go"],
  ["go test -memprofile=mem.out", "go"],
  ["go test -trace=t.out", "go"],
  ["go test -outputdir=out", "go"],
  ["pytest --basetemp=tmp", "pytest"],
  ["pytest --html=report.html", "pytest"],
  ["vitest run -o", "vitest"],
  ["npm test -- -o", "npm"],
];

describe("classifyText", () => {
  it.each(INERT)("claims nothing for `%s`", (text) => {
    expect(classifyText(text)).toMatchObject({ opaque: undefined, writes: [] });
  });

  it.each(TARGETED)("claims the writes of `%s`", (text, tokens) => {
    const claims = classifyText(text);
    // `sed -i a.ts` has a script and no file: it writes nothing nameable.
    expect(claims.opaque).toBe(tokens.length === 0 ? "sed" : undefined);
    expect(claims.writes.flatMap((write) => write.tokens)).toEqual(tokens);
  });

  it.each([...OPAQUE, ...OPAQUE_SCRIPTS, ...OPAQUE_CHECKS])("cannot list the writes of `%s`", (text, program) => {
    expect(classifyText(text).opaque).toBe(program);
  });

  it("never names an argument or an environment prefix for an opaque command", () => {
    const { opaque } = classifyText("SECRET=hunter2 /opt/bin/builder --token abc123");
    expect(opaque).toBe("builder");
  });

  it("treats a write after a cd as written from where the cd went", () => {
    const [write] = classifyText("cd sub && rm a.ts").writes;
    expect(write).toEqual({ tokens: ["a.ts"], trees: ["a.ts"], moves: false, steps: [{ name: "cd", target: "sub", lasting: true }] });
  });

  it("says which directory changes move the shell itself: not a subshell's, not a -c string's", () => {
    const left = (text: string) => classifyText(text).left.map(({ target }) => target);
    expect(left("cd a && cat x; cd b")).toEqual(["a", "b"]);
    expect(left("(cd a && cat x)")).toEqual([]);
    expect(left("bash -c 'cd a'")).toEqual([]);
  });

  it("keeps what is written to scratch space apart from the checkout's writes", () => {
    const claims = classifyText('echo x > /tmp/a && echo y > b.ts && echo z >> /private/tmp/x');
    expect(claims.writes.flatMap(({ tokens }) => tokens)).toEqual(["b.ts"]);
    expect(claims.scratch.flatMap(({ tokens }) => tokens)).toEqual(["/tmp/a", "/private/tmp/x"]);
    expect(classifyText('echo x > "$TMPDIR/a"').scratch).toHaveLength(1);
  });

  it.each([
    ["rm a.ts b.ts", ["a.ts", "b.ts"]],
    ["rmdir src/old", ["src/old"]],
    ["git rm -r src/old", ["src/old"]],
    ["git checkout -- src/dir", ["src/dir"]],
    ["git restore src/dir .", ["src/dir", "."]],
    ["mv src/a src/b", ["src/a"]],
    ["git mv src/a src/b", ["src/a"]],
    ["cp -r src/a lib", ["lib", "lib/a"]],
    ["cp -a src/a lib/", ["lib", "lib/a"]],
    ["mkdir -p out/x", []],
    ["touch a.ts", []],
    ["install -d out/x", []],
    ["install a.ts out/b.ts", []],
    ["cp a.ts b.ts", []],
    ["tee out.ts", []],
    ["echo x > out.ts", []],
    ["sed -i s/a/b/ a.ts", []],
  ])("claims everything beneath only what `%s` removes, moves away or copies recursively", (text, trees) => {
    expect(classifyText(text).writes.flatMap((write) => write.trees)).toEqual(trees);
  });

  it("claims nothing for a git rm that only touches the index, and a directory for a plain one", () => {
    expect(classifyText("git rm --cached a.ts")).toMatchObject({ opaque: undefined, writes: [] });
    expect(classifyText("git rm a.ts").writes).toHaveLength(1);
  });

  it("marks a move, so a moved directory's files are claimed at the destination too", () => {
    expect(classifyText("mv a b").writes[0]?.moves).toBe(true);
    expect(classifyText("git mv a b").writes[0]?.moves).toBe(true);
    expect(classifyText("cp a b").writes[0]?.moves).toBe(false);
  });

  it("calls a perl in-place edit opaque when its code calls something that writes", () => {
    for (const call of ["mkdir", "rmdir", "truncate", "symlink", "link", "chmod", "rename", "unlink", "open"]) {
      expect(classifyText(`perl -pi -e '${call} "x"' a.ts`).opaque, call).toBe("perl");
    }
    expect(classifyText("perl -pi -e 's/x/y/' a.ts").opaque).toBeUndefined();
  });

  it("reads the commands inside a subshell and a substitution", () => {
    expect(classifyText("(rm a.ts)").writes[0]?.tokens).toEqual(["a.ts"]);
    expect(classifyText("echo $(rm a.ts)").writes[0]?.tokens).toEqual(["a.ts"]);
  });

  it("flags git that writes history, unwrapped", () => {
    for (const text of ["git commit -m x", "bash -lc 'git commit -m x'", "git cherry-pick abc", "git pull --rebase", "git stash pop", "git reset --soft HEAD~1", "git -C . merge x"]) {
      expect(classifyText(text).history, text).toBe(true);
    }
    for (const text of ["git status", "git log", "git stash list", "git add -A"]) {
      expect(classifyText(text).history, text).toBe(false);
    }
  });

  it("holds the invariant: no inert entry rewrites the tree or carries a fixer flag", () => {
    for (const text of INERT) {
      for (const command of lexCommands(text, 8_192)) {
        const inner = unwrap(command.words);
        if (inner === null) {
          continue;
        }
        expect(rewritesTree(inner.parsed), text).toBe(false);
        expect(inner.parsed.args.some(({ text: arg }) => FIXER_FLAGS.has(arg)), text).toBe(false);
      }
    }
  });
});

const base = { kind: "work", status: "completed", startedAt: 20_000, createdAt: 20_000, completedAt: 21_000 };
const command = (text: string, over: Record<string, unknown> = {}) => ({ ...base, workKind: "command", approvalStatus: null, command: text, cwd: "/w", ...over });
const tool = (toolArgs: unknown, over: Record<string, unknown> = {}) => ({ ...base, workKind: "tool", approvalStatus: null, toolName: "write", toolArgs, ...over });
const fileRead = (cmd: string | null, over: Record<string, unknown> = {}) => ({ ...base, workKind: "file-read", path: "src/a.ts", cmd, ...over });
const search = (cmd: string | null) => ({ ...base, workKind: "search", mode: "content", path: null, cmd, query: "src/a.ts" });
const classify = (...rows: unknown[]) => classifyRows([rows as never], STARTED_AT, NOW);
/** One list of rows per thread. */
const classifyThreads = (...threads: unknown[][]) => classifyRows(threads as never, STARTED_AT, NOW);

describe("classifyRows", () => {
  it("takes the cmd of a file-read or search row, and a denied row, for inert", () => {
    const claims = classify(
      fileRead("cat src/a.ts"),
      search("rg src/a.ts"),
      command("rm src/a.ts", { approvalStatus: "denied" }),
      command("rm src/a.ts", { approvalStatus: "waiting_for_approval" }),
    );
    expect(claims).toMatchObject({ opaque: undefined, writes: [], names: [], windows: [] });
  });

  it("collects the writes of a targeted command with its cwd, and none of an opaque one's", () => {
    const claims = classify(command("sed -i s/a/b/ src/a.ts", { cwd: "/w/sub" }), command("npm run build"));
    expect(claims.opaque).toBe("npm");
    expect(claims.writes).toEqual([{ tokens: ["src/a.ts"], trees: [], moves: false, steps: [], cwd: "/w/sub" } satisfies RowWrite]);
    expect(claims.windows).toEqual([{ start: 19_000, end: 22_000 }]);
  });

  describe("the directory a thread's shell keeps from row to row", () => {
    const at = (text: string, startedAt: number, over: Record<string, unknown> = {}) =>
      command(text, { cwd: "", startedAt, createdAt: startedAt, completedAt: startedAt + 100, ...over });

    it("carries a cd to the rows after it, whatever order the pages gave them in", () => {
      const rows = [at("cd sub", 20_000), at("sed -i s/a/b/ a.ts", 21_000)];
      for (const ordered of [rows, [...rows].reverse()]) {
        const [write] = classify(...ordered).writes;
        expect(write).toMatchObject({ tokens: ["a.ts"], cwd: "", steps: [{ name: "cd", target: "sub" }] });
      }
    });

    it("carries a cd made before the turn began", () => {
      const claims = classify(at("cd sub", 1_000), at("rm a.ts", 21_000));
      expect(claims.writes[0]?.steps).toEqual([{ name: "cd", target: "sub", lasting: true }]);
      expect(claims.opaque).toBeUndefined();
    });

    it("starts again from a row that records its own cwd", () => {
      const claims = classify(at("cd sub", 20_000), at("rm a.ts", 21_000, { cwd: "/w" }));
      expect(claims.writes[0]).toMatchObject({ cwd: "/w", steps: [] });
    });

    it("keeps a thread's cd from the rows of another thread, and a delegation's from its parent's", () => {
      const cd = at("cd sub", 20_000);
      const write = at("rm a.ts", 21_000);
      expect(classifyThreads([cd], [write]).writes[0]?.steps).toEqual([]);
      const delegation = { ...base, workKind: "delegation", childRef: null, childRows: [{ ...cd, kind: "work" }] };
      expect(classify(delegation, write).writes[0]?.steps).toEqual([]);
    });

    it("does not carry what a subshell, a -c string or a row that never ran did", () => {
      const claims = classify(
        at("(cd sub && cat x)", 20_000),
        at("bash -c 'cd other'", 20_200),
        at("cd denied", 20_400, { approvalStatus: "denied" }),
        at("rm a.ts", 21_000),
      );
      expect(claims.writes[0]?.steps).toEqual([]);
    });

    it("leaves a tool's shell its own: it neither starts from nor changes a command row's", () => {
      const claims = classify(at("cd sub", 20_000), tool({ command: "rm a.ts" }), at("rm b.ts", 22_000));
      expect(claims.writes.map(({ tokens, cwd, steps }) => [tokens[0], cwd, steps.length])).toEqual([["a.ts", null, 0], ["b.ts", "", 1]]);
    });
  });

  describe("a cd from before the lookback", () => {
    const at = (text: string, startedAt: number) => command(text, { cwd: "", startedAt, createdAt: startedAt, completedAt: startedAt + 100 });

    it("is not carried: the shell is a guess again, and the write claims by the end of its path", async () => {
      const old = at("cd sub", STARTED_AT - FAMILY_LOOKBACK_MS - 1);
      const claims = classify(old, at("rm a.ts", 21_000));
      expect(claims.writes[0]?.steps).toEqual([]);
      const result = await resolveClaims(
        { sdk: { environments: { get: async () => ({ path: "/w" }) } } } as never,
        "env",
        claims,
        ["sub/a.ts", "lib/b.ts"],
      );
      expect(result).toMatchObject({ sweep: undefined });
      expect([...result.claimed]).toEqual(["sub/a.ts"]);
    });

    it("is carried from the edge of the lookback on", () => {
      const claims = classify(at("cd sub", STARTED_AT - FAMILY_LOOKBACK_MS), at("rm a.ts", 21_000));
      expect(claims.writes[0]?.steps).toEqual([{ name: "cd", target: "sub", lasting: true }]);
    });
  });

  describe("tool rows", () => {
    it("reads only a command or cmd field as shell, never a description or other prose", () => {
      const prose = classify(tool({ text: "test the endpoint and fix it", description: "sort out the imports" }, { toolName: "assist" }));
      expect(prose).toMatchObject({ opaque: undefined, writes: [] });
      expect(prose.tools).toEqual([{ tool: "assist", names: expect.any(Array), shell: false }]);
      const both = classify(tool({ command: "sed -i s/a/b/ a.ts", description: "Fix it" }, { toolName: "assist" }));
      expect(both).toMatchObject({ opaque: undefined });
      expect(both.writes.flatMap(({ tokens }) => tokens)).toEqual(["a.ts"]);
      expect(both.tools[0]?.shell).toBe(true);
      expect(classify(tool({ input: { cmd: "npm run build" } }, { toolName: "assist" })).opaque).toBe("npm");
    });

    it("reads an array command as the shell line its words make, quoted", () => {
      const run = classify(tool({ command: ["bash", "-lc", "npm run codegen"] }, { toolName: "assist" }));
      expect(run.opaque).toBe("npm");
      const edit = classify(tool({ command: ["sed", "-i", "s/a b/c/", "src/a.ts"] }, { toolName: "assist" }));
      expect(edit).toMatchObject({ opaque: undefined });
      expect(edit.writes.flatMap(({ tokens }) => tokens)).toEqual(["src/a.ts"]);
      expect(edit.tools[0]?.shell).toBe(true);
      expect(classify(tool({ command: ["it's"] }, { toolName: "assist" })).tools[0]?.shell).toBe(true);
    });

    it("reads a script or code field as shell too", () => {
      expect(classify(tool({ script: "npm run codegen" }, { toolName: "assist" })).opaque).toBe("npm");
      expect(classify(tool({ input: { code: "rm src/a.ts" } }, { toolName: "assist" })).writes[0]?.tokens).toEqual(["src/a.ts"]);
    });

    it("is opaque for a tool given any other string that opens with a program opaque by name, and not for prose or content", () => {
      for (const text of ["npm run codegen", "pnpm install", "npx prisma generate", "node build.js", "python3 gen.py", "make all", "prettier --write src", "bash run.sh"]) {
        expect(classify(tool({ file: "src/a.ts", note: text }, { toolName: "assist" })).opaque, text).toBeDefined();
      }
      for (const text of ["npm test", "Fix the imports please", "test the endpoint and fix it", "sort out the imports", "unknownword with spaces"]) {
        expect(classify(tool({ file: "src/a.ts", note: text }, { toolName: "assist" })).opaque, text).toBeUndefined();
      }
      expect(classify(tool({ file: "src/a.ts", script: "npm run codegen" }, { toolName: "assist" })).opaque).toBe("npm");
      expect(classify(tool({ file: "src/a.ts", note: "npm run codegen" }, { toolName: "devkit_docs" })).opaque).toBeUndefined();
    });

    it.each(["devkit_find_skills", "devkit_load_skill", "devkit_docs", "agent_checklist_get", "agent_checklist_update", "progressive_skill_list", "progressive_skill_used", "runtime_search", "runtime_thread", "runtime_skill_resource", "ReportReview", "update_environment_directory", "bb_keep_checkout", "advisor_review"])(
      "takes the bridge tool %s for read-only, bare or by its bridge name, whatever it is given",
      (name) => {
        for (const toolName of [name, `mcp__bb-bridge__${name}`]) {
          expect(classify(tool({ skill: "load the review skill and run it" }, { toolName })), toolName).toMatchObject({ opaque: undefined, tools: [], names: [], writes: [] });
        }
      },
    );

    it.each(["runtime_container", "runtime_git", "runtime_ops", "platform_container", "some_new_tool"])(
      "does not take %s for read-only, bare or by its bridge name: it is read through what it is given",
      (name) => {
        for (const toolName of [name, `mcp__bb-bridge__${name}`]) {
          const claims = classify(tool({ operation: "build the project" }, { toolName }));
          expect(claims.tools, toolName).toEqual([{ tool: toolName, names: ["operation", "build the project"], shell: false }]);
        }
      },
    );
  });

  describe("delegation rows", () => {
    const delegation = (childRows: unknown[], over: Record<string, unknown> = {}) => ({
      ...base,
      workKind: "delegation",
      callId: "c1",
      toolName: "Agent",
      childRef: null,
      childRows,
      ...over,
    });

    it("is opaque, with a window, when it shows nothing of what the subagent ran", () => {
      const claims = classify(delegation([]));
      expect(claims).toMatchObject({ opaque: "delegation", windows: [{ start: 19_000, end: 22_000 }] });
      expect(classify(delegation([{ kind: "conversation", id: "x" }])).opaque).toBe("delegation");
    });

    it("is read through its nested work rows when it has any", () => {
      const claims = classify(delegation([command("cat src/a.ts"), command("rm src/a.ts")]));
      expect(claims).toMatchObject({ opaque: undefined, windows: [] });
      expect(claims.writes.flatMap(({ tokens }) => tokens)).toEqual(["src/a.ts"]);
      expect(classify(delegation([command("npm run build")])).opaque).toBe("npm");
    });

    it("is read through a child thread whose rows were read", () => {
      const kidRow = { ...command("cat a.ts"), threadId: "kid-1" };
      expect(classifyThreads([delegation([], { childRef: "kid-1" })], [kidRow]).opaque).toBeUndefined();
      expect(classifyThreads([delegation([], { childRef: "kid-2" })], [kidRow]).opaque).toBe("delegation");
    });
  });

  it("claims the paths a tool row's arguments name, and runs a string with whitespace as shell", () => {
    const named = classify(tool({ path: "src/a.ts" }));
    expect(named).toMatchObject({ opaque: undefined, names: ["path", "src/a.ts"] });
    expect(classify(tool({ command: "npm run format" })).opaque).toBe("npm");
    expect(classify(tool({ command: "echo hi > src/a.ts" })).writes[0]?.tokens).toEqual(["src/a.ts"]);
  });

  it("is opaque for a tool row that names nothing and is not on the read-only list", () => {
    expect(classify(tool(null)).opaque).toBe("write");
    expect(classify(tool({}, { toolName: "devkit_find_skills" })).opaque).toBeUndefined();
    for (const toolName of ["ToolSearch", "Skill", "Read", "read", "fetch", "advisor_review", "agent_checklist_get", "progressive_skill_list"]) {
      expect(classify(tool(null, { toolName })).opaque, toolName).toBeUndefined();
    }
  });

  it.each(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop", "SendMessage", "ListAgents", "CronCreate", "CronDelete", "CronList", "PushNotification"])(
    "takes the bookkeeping tool %s for inert, whatever it is given",
    (toolName) => {
      expect(classify(tool({ todos: [{ content: "write the docs", status: "pending" }] }, { toolName }))).toMatchObject({ opaque: undefined, tools: [], names: [] });
    },
  );

  it("keeps Monitor opaque: it runs commands", () => {
    expect(classify(tool({ command: "until true; do sleep 1; done" }, { toolName: "Monitor" })).tools).toHaveLength(1);
    expect(classify(tool(null, { toolName: "Monitor" })).opaque).toBe("Monitor");
  });

  it("treats a work row of another kind as inert unless it can write", () => {
    expect(classify({ ...base, workKind: "web-search" }).opaque).toBeUndefined();
    expect(classify({ ...base, workKind: "image-generation" }).opaque).toBe("image-generation");
  });

  it("leaves out a row that ended before the turn", () => {
    expect(classify(command("npm run build", { startedAt: 1_000, completedAt: 2_000 })).opaque).toBeUndefined();
  });

  it("reads a row that recorded no end as running until now", () => {
    expect(classify(command("npm run build", { completedAt: null })).opaque).toBe("npm");
  });

  it("does not sweep for an opaque row that began before the turn and is still open", () => {
    const stale = command("npm run dev", { status: "pending", completedAt: null, startedAt: 5_000, createdAt: 5_000 });
    const claims = classify(stale, command("rm src/a.ts"));
    expect(claims).toMatchObject({ opaque: undefined, stale: ["npm"], windows: [] });
    expect(claims.writes.flatMap(({ tokens }) => tokens)).toEqual(["src/a.ts"]);
  });

  it("sweeps for a row that began before the turn but finished during it", () => {
    expect(classify(command("npm run build", { startedAt: 5_000, createdAt: 5_000, completedAt: 12_000 })).opaque).toBe("npm");
  });

  it("flags history git of every kind of command row, tool strings included", () => {
    expect(classify(command("git commit -m x")).history).toBe(true);
    expect(classify(tool({ command: "git cherry-pick abc" })).history).toBe(true);
    expect(classify(command("git status")).history).toBe(false);
  });
});

describe("resolveClaims", () => {
  const bb = (path: string | null | Error, gets: unknown[] = []) =>
    ({
      sdk: {
        environments: {
          get: async (args: unknown) => {
            gets.push(args);
            if (path instanceof Error) {
              throw path;
            }
            return { path };
          },
        },
      },
    }) as never;
  const candidates = ["src/a.ts", "src/legacy/b.ts", "src/legacy/deep/c.ts", "lib/d.ts", "e.ts"];
  const resolve = (rows: unknown[], root: string | null | Error = "/w") =>
    resolveClaims(bb(root), "env", classify(...rows), candidates);

  it("claims the files a targeted command names, both sides of a move, and everything under a directory", async () => {
    expect([...(await resolve([command("sed -i s/a/b/ src/a.ts")])).claimed]).toEqual(["src/a.ts"]);
    expect([...(await resolve([command("mv src/a.ts lib/d.ts")])).claimed].sort()).toEqual(["lib/d.ts", "src/a.ts"]);
    expect([...(await resolve([command("rm -r src/legacy")])).claimed].sort()).toEqual(["src/legacy/b.ts", "src/legacy/deep/c.ts"]);
  });

  it("resolves a token against the row's cwd and an absolute one against the root", async () => {
    expect([...(await resolve([command("rm a.ts", { cwd: "/w/src" })])).claimed]).toEqual(["src/a.ts"]);
    expect([...(await resolve([command("rm /w/lib/d.ts")])).claimed]).toEqual(["lib/d.ts"]);
    expect([...(await resolve([command("rm /elsewhere/e.ts")])).claimed]).toEqual([]);
  });

  it("claims what a glob matches, and the whole checkout for `.`", async () => {
    expect([...(await resolve([command("rm src/*.ts")])).claimed]).toEqual(["src/a.ts"]);
    expect([...(await resolve([command("git restore .")])).claimed].sort()).toEqual([...candidates].sort());
  });

  it("claims what a tool's argument names, exactly or as the end of an absolute path", async () => {
    const gets: unknown[] = [];
    const claimed = (await resolveClaims(bb("/w", gets), "env", classify(tool({ path: "src/a.ts" }), tool({ file: "/w/lib/d.ts" }), tool({ file: "/w/xlib/d.ts.bak" })), candidates)).claimed;
    expect([...claimed].sort()).toEqual(["lib/d.ts", "src/a.ts"]);
    expect(gets).toEqual([]);
  });

  it("sweeps for a tool that is not read-only and names no changed path, naming the tool but not its arguments", async () => {
    const unknown = tool({ symbol: "Foo.bar" }, { toolName: "edit_symbol" });
    const result = await resolve([unknown]);
    expect(result.sweep).toBe("the edit_symbol tool named no changed path");
    expect(result.sweep).not.toContain("Foo.bar");
    expect((await resolve([tool({ path: "nowhere.ts" }, { toolName: "edit_symbol" })])).sweep).toMatch(/edit_symbol/u);
  });

  it("does not sweep for a tool that names a changed path, or is read as a shell command, or is read-only", async () => {
    expect((await resolve([tool({ path: "src/a.ts" }, { toolName: "edit_symbol" })])).sweep).toBeUndefined();
    expect((await resolve([tool({ command: "npm test" }, { toolName: "run" })])).sweep).toBeUndefined();
    expect((await resolve([tool({ todos: ["x"] }, { toolName: "TodoWrite" })])).sweep).toBeUndefined();
  });

  it("does not sweep for a tool that began before the turn and is still open", async () => {
    const open = tool({ symbol: "x" }, { toolName: "watch", status: "pending", completedAt: null, startedAt: 5_000, createdAt: 5_000 });
    expect((await resolve([open])).sweep).toBeUndefined();
  });

  it("allows a write after a cd that returns to the checkout root, and sweeps after any other", async () => {
    expect([...(await resolve([command("cd /w && rm e.ts", { cwd: "/w/src" })])).claimed]).toEqual(["e.ts"]);
    const away = await resolve([command("cd sub && rm e.ts")]);
    expect(away.sweep).toMatch(/cd/u);
  });

  it("sweeps when the checkout path is unknown, and asks for it only when a command wrote by name", async () => {
    expect((await resolve([command("rm e.ts")], null)).sweep).toMatch(/checkout path/u);
    expect((await resolve([command("rm e.ts")], new Error("gone"))).sweep).toMatch(/checkout path/u);
    const gets: unknown[] = [];
    await resolveClaims(bb("/w", gets), "env", classify(command("cat e.ts")), candidates);
    expect(gets).toEqual([]);
  });

  describe("a shell whose directory is a guess", () => {
    const at = (text: string, startedAt: number, cwd = "") =>
      command(text, { cwd, startedAt, createdAt: startedAt, completedAt: startedAt + 100 });
    const claimedBy = async (rows: unknown[], root: string | null | Error = "/w", among: readonly string[] = candidates) =>
      [...(await resolveClaims(bb(root), "env", classify(...rows), among)).claimed].sort();

    it("claims every changed path that ends in a relative token when no cwd and no cd says where the shell was", async () => {
      expect(await claimedBy([at("sed -i s/a/b/ b.ts", 20_000)])).toEqual(["src/legacy/b.ts"]);
      expect(await claimedBy([at("sed -i s/a/b/ d.ts", 20_000)])).toEqual(["lib/d.ts"]);
      expect(await claimedBy([at("rm e.ts", 20_000)])).toEqual(["e.ts"]);
      expect(await claimedBy([at("rm src/a.ts", 20_000)])).toEqual(["src/a.ts"]);
      expect(await claimedBy([at("echo x > deep/c.ts", 20_000)])).toEqual(["src/legacy/deep/c.ts"]);
    });

    it("claims what is beneath a directory token by prefix only for a command that claims directories", async () => {
      expect(await claimedBy([at("rm -r legacy", 20_000)])).toEqual(["src/legacy/b.ts", "src/legacy/deep/c.ts"]);
      expect(await claimedBy([at("mkdir -p legacy", 20_000)])).toEqual([]);
      expect(await claimedBy([at("touch legacy", 20_000)])).toEqual([]);
    });

    it("does not guess when the cwd says where the shell was", async () => {
      expect(await claimedBy([at("rm b.ts", 20_000, "/w")])).toEqual([]);
      expect(await claimedBy([at("rm b.ts", 20_000, "src/legacy")])).toEqual(["src/legacy/b.ts"]);
    });

    it("does not lose a write made after a cd in an earlier row: the directory carries, and a cd away from the root is a sweep", async () => {
      const result = await resolveClaims(bb("/w"), "env", classify(at("cd sub", 20_000), at("sed -i s/a/b/ a.ts", 21_000)), ["sub/a.ts", "e.ts"]);
      expect(result.sweep).toMatch(/cd/u);
      expect(await claimedBy([at("cd /w", 20_000), at("rm e.ts", 21_000)])).toEqual(["e.ts"]);
      // The carried cd back to the root is certain, so a relative token is no longer a guess.
      expect(await claimedBy([at("cd /w", 20_000), at("rm d.ts", 21_000)])).toEqual([]);
    });

    it("claims only the exact path after a carried cd back to the root", async () => {
      const among = ["lib/d.ts", "d.ts", "lib/deep/d.ts"];
      expect(await claimedBy([at("cd /w", 20_000), at("rm d.ts", 21_000)], "/w", among)).toEqual(["d.ts"]);
      expect(await claimedBy([at("cd /w && cd lib && cd /w", 20_000), at("sed -i s/a/b/ lib/d.ts", 21_000)], "/w", among)).toEqual(["lib/d.ts"]);
      expect(await claimedBy([at("rm d.ts", 21_000)], "/w", among)).toEqual(["d.ts", "lib/d.ts", "lib/deep/d.ts"]);
    });

    it("claims by the end of the path when the cwd is absolute and not under the checkout", async () => {
      expect(await claimedBy([at("rm a.ts", 20_000, "/elsewhere/repo/src")])).toEqual(["src/a.ts"]);
      expect(await claimedBy([at("rm -r legacy", 20_000, "/elsewhere/repo/src")])).toEqual(["src/legacy/b.ts", "src/legacy/deep/c.ts"]);
    });

    it("reads /var and /private/var as the same place, so an aliased cwd or path is not a guess", async () => {
      const root = "/private/var/x/repo";
      expect(await claimedBy([at("rm d.ts", 20_000, "/var/x/repo/lib")], root)).toEqual(["lib/d.ts"]);
      expect(await claimedBy([at("rm a.ts", 20_000, "/var/x/repo/lib")], root)).toEqual([]);
      expect(await claimedBy([at("rm /var/x/repo/lib/d.ts", 20_000, "/w")], root)).toEqual(["lib/d.ts"]);
      expect(await claimedBy([at("rm /var/x/other/lib/d.ts", 20_000, "/w")], root)).toEqual([]);
    });

    it("is still sweeping, not guessing, when the checkout path is unknown", async () => {
      expect((await resolveClaims(bb(null), "env", classify(at("rm b.ts", 20_000)), candidates)).sweep).toMatch(/checkout path/u);
    });
  });

  describe("what a command claims of the paths it names", () => {
    const claimedBy = async (text: string, among: readonly string[]) =>
      [...(await resolveClaims(bb("/w"), "env", classify(command(text)), among)).claimed].sort();

    it("claims the exact destination and each source's name inside it for a copy or move, never the whole directory", async () => {
      const among = ["lib/a.ts", "lib/other.ts", "a.ts", "b.ts", "b.ts.bak"];
      expect(await claimedBy("cp a.ts lib", among)).toEqual(["lib/a.ts"]);
      expect(await claimedBy("cp a.ts lib/", among)).toEqual(["lib/a.ts"]);
      expect(await claimedBy("cp a.ts b.ts", among)).toEqual(["b.ts"]);
      expect(await claimedBy("install a.ts lib", among)).toEqual(["lib/a.ts"]);
      expect(await claimedBy("mv a.ts lib", among)).toEqual(["a.ts", "lib/a.ts"]);
      expect(await claimedBy("git mv a.ts lib", among)).toEqual(["a.ts", "lib/a.ts"]);
    });

    it("claims a recursive copy's whole destination", async () => {
      const among = ["lib/a/x.ts", "lib/other.ts", "src/a/x.ts"];
      expect(await claimedBy("cp -r src/a lib", among)).toEqual(["lib/a/x.ts", "lib/other.ts"]);
    });

    it("claims a moved directory's files at both ends, and no more", async () => {
      const among = ["src/old/a.ts", "src/old/deep/b.ts", "src/new/a.ts", "src/new/deep/b.ts", "src/other.ts"];
      expect(await claimedBy("git mv src/old src/new", among)).toEqual(["src/new/a.ts", "src/new/deep/b.ts", "src/old/a.ts", "src/old/deep/b.ts"]);
      expect(await claimedBy("mv src/old src/new", among)).toEqual(["src/new/a.ts", "src/new/deep/b.ts", "src/old/a.ts", "src/old/deep/b.ts"]);
      // A source that is a changed file itself is a file: only it lands at the destination.
      expect(await claimedBy("mv src/old.ts src/new", ["src/old.ts", "src/other.ts", "src/new/old.ts", "src/new/x.ts"])).toEqual(["src/new/old.ts", "src/old.ts"]);
    });

    it("claims a destination and everything beneath it when no changed path is the source or lies under it", async () => {
      const among = ["src/feature/a.ts", "src/feature/deep/b.ts", "src/other.ts"];
      for (const text of ["mv tmpdir src/feature", "git mv tmpdir src/feature", "mv tmpdir/ src/feature/", "mv src/feature.tmp src/feature"]) {
        expect(await claimedBy(text, among), text).toEqual(["src/feature/a.ts", "src/feature/deep/b.ts"]);
      }
    });

    it("claims the exact path for mkdir, touch and install -d, and what is beneath a path only for rm, rmdir and git rm", async () => {
      const among = ["src/legacy/b.ts", "src/legacy/deep/c.ts", "src/a.ts"];
      expect(await claimedBy("mkdir -p src/legacy", among)).toEqual([]);
      expect(await claimedBy("touch src/legacy", among)).toEqual([]);
      expect(await claimedBy("install -d src/legacy", among)).toEqual([]);
      expect(await claimedBy("touch src/a.ts", among)).toEqual(["src/a.ts"]);
      for (const text of ["rm -r src/legacy", "rm src/legacy", "rmdir src/legacy", "git rm -r src/legacy"]) {
        expect(await claimedBy(text, among), text).toEqual(["src/legacy/b.ts", "src/legacy/deep/c.ts"]);
      }
    });

    it("claims a glob only for the paths it matches, with what is beneath a match only for a command that claims directories", async () => {
      const among = ["src/legacy/b.ts", "src/a.ts", "src/b.txt"];
      expect(await claimedBy("touch src/*", among)).toEqual(["src/a.ts", "src/b.txt"]);
      expect(await claimedBy("rm src/*", among)).toEqual(["src/a.ts", "src/b.txt", "src/legacy/b.ts"]);
    });

    it("claims nothing for git rm --cached, which only changes the index", async () => {
      expect(await claimedBy("git rm --cached src/a.ts", ["src/a.ts"])).toEqual([]);
      expect(await claimedBy("git rm src/a.ts", ["src/a.ts"])).toEqual(["src/a.ts"]);
    });
  });

  describe("scratch space", () => {
    const scratchRoot = "/private/var/folders/ab/cd/T/repo";
    const claimedBy = async (text: string, root: string | null | Error, among: readonly string[] = ["src/a.ts", "lib/d.ts"]) =>
      resolveClaims(bb(root), "env", classify(command(text)), among);

    it("does not take a path for scratch when it lies under the checkout, which itself may lie in scratch space", async () => {
      const result = await claimedBy(`echo x > ${scratchRoot}/src/a.ts && echo y > /tmp/other.ts`, scratchRoot);
      expect([...result.claimed]).toEqual(["src/a.ts"]);
      expect(result.sweep).toBeUndefined();
      expect([...(await claimedBy("rm -r /var/folders/ab/cd/T/repo/lib", scratchRoot)).claimed]).toEqual(["lib/d.ts"]);
    });

    it("still skips scratch writes when the checkout is elsewhere", async () => {
      const gets: unknown[] = [];
      const result = await resolveClaims(bb("/w", gets), "env", classify(command("echo x > /tmp/a.ts && echo y > \"$TMPDIR/b.ts\"")), ["a.ts", "b.ts"]);
      expect(result).toMatchObject({ claimed: new Set(), sweep: undefined });
      expect(gets).toHaveLength(1);
    });

    it("sweeps when the checkout lies in scratch space and a write goes through a variable, which could be inside it", async () => {
      expect((await claimedBy('echo x > "$TMPDIR/repo/src/a.ts"', scratchRoot)).sweep).toMatch(/scratch/u);
      expect((await claimedBy("echo x > /tmp/$RANDOM.log", scratchRoot)).sweep).toMatch(/scratch/u);
      expect((await claimedBy("echo x > /tmp/$RANDOM.log", "/w")).sweep).toBeUndefined();
    });

    it("sweeps for nothing when the checkout path is unknown and only scratch was written", async () => {
      expect((await claimedBy("echo x > /tmp/a.ts", null)).sweep).toBeUndefined();
    });
  });

  it("tells what a targeted command wrote from what a tool's argument named", async () => {
    const result = await resolveClaims(
      bb("/w"),
      "env",
      classify(tool({ path: "src/a.ts" }), command("rm lib/d.ts")),
      candidates,
    );
    expect([...result.claimed].sort()).toEqual(["lib/d.ts", "src/a.ts"]);
    expect([...result.written]).toEqual(["lib/d.ts"]);
  });

  it("sweeps for a tool that is told only prose, naming the tool", async () => {
    for (const args of [{ prompt: "test the endpoint and fix it" }, { description: "sort out the imports" }]) {
      const result = await resolve([tool(args, { toolName: "assist" })]);
      expect(result.sweep).toBe("the assist tool named no changed path");
    }
  });

  it("does not sweep for a tool whose command field names its write and whose description is prose", async () => {
    const run = tool({ command: "sed -i s/a/b/ src/a.ts", description: "Fix it" }, { toolName: "assist" });
    const result = await resolve([run]);
    expect(result.sweep).toBeUndefined();
    expect([...result.claimed]).toEqual(["src/a.ts"]);
  });

  it("is opaque for a tool whose script field runs something, and sweeps on prose only when it names no changed path", async () => {
    const sweeps = async (args: unknown) => (await resolve([tool(args, { toolName: "assist" })])).sweep;
    expect(classify(tool({ file: "src/a.ts", script: "npm run codegen" }, { toolName: "assist" })).opaque).toBe("npm");
    expect(await sweeps({ file: "src/a.ts", note: "Fix the imports please" })).toBeUndefined();
    expect(await sweeps({ note: "Fix the imports please" })).toBe("the assist tool named no changed path");
  });

  it("claims the backup of an in-place edit that makes one", async () => {
    const among = ["src/a.ts", "src/a.ts.bak", "src/b.ts.bak"];
    const claimedBy = async (text: string) => [...(await resolveClaims(bb("/w"), "env", classify(command(text)), among)).claimed].sort();
    expect(await claimedBy("sed -i.bak s/x/y/ src/a.ts")).toEqual(["src/a.ts", "src/a.ts.bak"]);
    expect(await claimedBy("perl -pi.bak -e s/x/y/ src/a.ts")).toEqual(["src/a.ts", "src/a.ts.bak"]);
    expect(await claimedBy("sed -i s/x/y/ src/a.ts")).toEqual(["src/a.ts"]);
  });

  it("sweeps for a write-capable bridge tool given a non-path argument, and not for a read-only one", async () => {
    for (const toolName of ["runtime_container", "mcp__bb-bridge__runtime_container", "runtime_git", "mcp__bb-bridge__runtime_git"]) {
      expect((await resolve([tool({ operation: "build" }, { toolName })])).sweep, toolName).toBe(`the ${toolName} tool named no changed path`);
    }
    for (const toolName of ["devkit_load_skill", "mcp__bb-bridge__devkit_load_skill"]) {
      expect((await resolve([tool({ skill: "review-code" }, { toolName })])).sweep, toolName).toBeUndefined();
    }
  });
});

describe("strayCommitReason", () => {
  const family = (...rows: unknown[]) => classify(...rows);
  const commit = { sha: "c1", paths: ["src/x.ts"], authoredAt: 30_000 };
  const none = new Set<string>();

  it("drops a commit when the family ran nothing that could have made it", () => {
    expect(strayCommitReason(commit, family(command("cat src/x.ts")), none)).not.toBeNull();
  });

  it.each(["git commit -m x", "bash -lc 'git commit -m x'", "git cherry-pick abc", "git pull --rebase", "git stash pop", "git reset --soft HEAD~1"])("keeps it when the family ran `%s`", (text) => {
    expect(strayCommitReason(commit, family(command(text)), none)).toBeNull();
  });

  it("keeps it when it was authored inside an opaque or tool row's window", () => {
    expect(strayCommitReason(commit, family(command("npm run build", { startedAt: 29_500, completedAt: 30_500 })), none)).toBeNull();
    expect(strayCommitReason(commit, family(tool({ path: "x" }, { startedAt: 29_500, completedAt: 30_500 })), none)).toBeNull();
    expect(strayCommitReason(commit, family(command("npm run build", { startedAt: 11_000, completedAt: 12_000 })), none)).not.toBeNull();
  });

  it("keeps it when its date or paths are unknown, or it touches a path the family claims", () => {
    expect(strayCommitReason({ ...commit, authoredAt: null }, family(), none)).toBeNull();
    expect(strayCommitReason({ ...commit, paths: null }, family(), none)).toBeNull();
    expect(strayCommitReason(commit, family(), new Set(["src/x.ts"]))).toBeNull();
  });
});
