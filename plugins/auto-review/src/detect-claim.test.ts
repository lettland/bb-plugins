import { describe, expect, it } from "vitest";
import { classifyRows, resolveClaims, strayCommitReason } from "./detect-claim.js";
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
  ["cp a.ts b.ts", ["b.ts"]],
  ["install a.ts b.ts", ["b.ts"]],
  ["mv a b", ["a", "b"]],
  ["rm a.ts", ["a.ts"]],
  ["rm -r src/legacy", ["src/legacy"]],
  ["git rm a.ts", ["a.ts"]],
  ["git mv a b", ["a", "b"]],
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
  ["cp a.ts src/", "cp"],
  ["cp a.ts b.ts c.ts", "cp"],
  ["cp -t dir a.ts", "cp"],
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
  ["echo `rm -rf src`", "echo"],
  ["echo \"$(rm -rf src)\"", "echo"],
  ["eval \"$CMD\"", "eval"],
  ["x".repeat(70_000), "(text over the limit)"],
  ["cat <<EOF\nbody", "(unterminated heredoc)"],
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

  it.each(OPAQUE)("cannot list the writes of `%s`", (text, program) => {
    expect(classifyText(text).opaque).toBe(program);
  });

  it("never names an argument or an environment prefix for an opaque command", () => {
    const { opaque } = classifyText("SECRET=hunter2 /opt/bin/builder --token abc123");
    expect(opaque).toBe("builder");
  });

  it("treats a write after a cd as written from where the cd went", () => {
    const [write] = classifyText("cd sub && rm a.ts").writes;
    expect(write).toEqual({ tokens: ["a.ts"], steps: [{ name: "cd", target: "sub" }] });
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
const classify = (...rows: unknown[]) => classifyRows(rows as never, STARTED_AT, NOW);

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
    expect(claims.writes).toEqual([{ tokens: ["src/a.ts"], steps: [], cwd: "/w/sub" }]);
    expect(claims.windows).toEqual([{ start: 19_000, end: 22_000 }]);
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
