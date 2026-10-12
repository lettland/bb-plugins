import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  claudeProfileLines,
  decidePin,
  isDirectory,
  resolveClaudeEnv,
  unpinThread,
  type ClaudeProfileDeps,
  type ConfigDirPin,
  type ProjectSource,
} from "./profile";
import type { Scope } from "./scopes";

function scope(name: string, root: string, claudeConfigDir: string | null): Scope {
  return {
    name,
    paths: [root],
    patterns: [],
    patternSources: [],
    claudeConfigDir,
  };
}

const work = scope("work", "/w", "/profiles/work");
const SERVER = "host_local";
const REMOTE = "host_remote";

function fakeKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    async get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

function setup(opts: {
  scopes?: Scope[];
  sources?: ProjectSource[] | undefined;
  dirs?: string[];
  kv?: Record<string, unknown>;
}) {
  const kv = fakeKv(opts.kv);
  const warnings: string[] = [];
  const deps: ClaudeProfileDeps = {
    scopes: opts.scopes ?? [work],
    log: { debug: () => {}, warn: (m: string) => void warnings.push(m) },
    kv,
    isDir: (p) => (opts.dirs ?? ["/profiles/work"]).includes(p),
    sourcesFor: async () => opts.sources,
  };
  return { deps, kv, warnings };
}

const ctx = { threadId: "thr_1", projectId: "proj_1", hostId: SERVER };
const workSource: ProjectSource = { path: "/w/repo", hostId: SERVER };

describe("decidePin", () => {
  const isDir = (p: string) => p === "/profiles/work";

  it("reports an unresolved project as unknown", () => {
    const d = decidePin([work], undefined, SERVER, isDir);
    expect(d.status).toBe("unknown");
    expect(d.pin).toEqual({ dir: null, scope: null, reason: "unknown-project" });
  });

  it("selects the profile for a matching checkout", () => {
    const d = decidePin([work], [workSource], SERVER, isDir);
    expect(d).toMatchObject({
      status: "profile",
      pin: { dir: "/profiles/work", scope: "work" },
    });
  });

  it("selects nothing when no scope matches", () => {
    const d = decidePin([work], [{ path: "/p/repo", hostId: SERVER }], SERVER, isDir);
    expect(d.status).toBe("none");
  });

  it("ignores checkouts on other hosts, but counts all hosts for null", () => {
    const remote = [{ path: "/w/repo", hostId: REMOTE }];
    expect(decidePin([work], remote, SERVER, isDir).status).toBe("none");
    expect(decidePin([work], remote, null, isDir).status).toBe("profile");
  });

  it("falls back to default with a warning when the dir is not a directory", () => {
    const d = decidePin([work], [workSource], SERVER, () => false);
    expect(d.status).toBe("missing-dir");
    expect(d.pin).toEqual({ dir: null, scope: null, reason: "missing-dir" });
    expect(d.configured).toEqual({ dir: "/profiles/work", scope: "work" });
    expect(d.warnings.join(" ")).toMatch(/not a directory/);
  });

  it("warns about conflicting scopes", () => {
    const other = scope("a-other", "/w", "/profiles/other");
    const d = decidePin([work, other], [workSource], SERVER, () => true);
    expect(d.pin.scope).toBe("a-other");
    expect(d.conflict).toEqual(["work"]);
    expect(d.warnings.join(" ")).toMatch(/different claudeConfigDir/);
  });
});

describe("isDirectory", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dir-skills-profile-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("is true only for a real directory", () => {
    const file = path.join(tmp, "file");
    writeFileSync(file, "x");
    expect(isDirectory(tmp)).toBe(true);
    expect(isDirectory(file)).toBe(false);
    expect(isDirectory(path.join(tmp, "missing"))).toBe(false);
  });
});

describe("claudeProfileLines", () => {
  const hint = "run `bb dir-skills unpin";

  it("says a project is needed when there is none", () => {
    expect(claudeProfileLines(null, null, undefined)).toEqual([
      "Claude profile: needs --project",
    ]);
  });

  it("shows the profile and scope", () => {
    const d = decidePin([work], [workSource], SERVER, () => true);
    const text = claudeProfileLines(d, null, undefined).join("\n");
    expect(text).toMatch(/\/profiles\/work {2}\(scope work\)/);
    expect(text).not.toMatch(/unpin/);
  });

  it("names the configured dir and scope for a missing dir, with the hint", () => {
    const d = decidePin([work], [workSource], SERVER, () => false);
    const text = claudeProfileLines(d, null, undefined).join("\n");
    expect(text).toMatch(/scope work sets \/profiles\/work, which is not a directory/);
    expect(text).toContain(hint);
  });

  it("labels an unknown project with the hint", () => {
    const d = decidePin([work], undefined, null, () => true);
    const text = claudeProfileLines(d, null, undefined).join("\n");
    expect(text).toMatch(/unknown project/);
    expect(text).toContain(hint);
  });

  it("shows a null pin's reason and the unpin hint for the thread", () => {
    const d = decidePin([work], [workSource], SERVER, () => true);
    const text = claudeProfileLines(
      d,
      { dir: null, scope: null, reason: "unknown-project" },
      "thr_9",
    ).join("\n");
    expect(text).toMatch(/pinned for thread thr_9: none \(default profile: project not resolved;/);
    expect(text).toContain("unpin thr_9");
  });
});

describe("resolveClaudeEnv", () => {
  it("lets an existing pin win over the scopes", async () => {
    const pin: ConfigDirPin = { dir: "/profiles/other", scope: "x" };
    const { deps } = setup({
      sources: [workSource],
      dirs: ["/profiles/other", "/profiles/work"],
      kv: { "claude-config-dir:thr_1": pin },
    });
    const out = await resolveClaudeEnv(deps, ctx);
    expect(out.map((e) => e.value)).toEqual(["/profiles/other"]);
  });

  it("pins and returns the profile for a local work checkout", async () => {
    const { deps, kv } = setup({ sources: [workSource] });
    const out = await resolveClaudeEnv(deps, ctx);
    expect(out).toEqual([
      {
        name: "CLAUDE_CONFIG_DIR",
        value: "/profiles/work",
        reason: 'dir-skills scope "work"',
      },
    ]);
    expect(kv.store.get("claude-config-dir:thr_1")).toEqual({
      dir: "/profiles/work",
      scope: "work",
    });
  });

  it("uses the default profile for a checkout on another host", async () => {
    const { deps, kv } = setup({
      sources: [{ path: "/w/repo", hostId: REMOTE }],
    });
    expect(await resolveClaudeEnv(deps, ctx)).toEqual([]);
    expect(kv.store.get("claude-config-dir:thr_1")).toEqual({
      dir: null,
      scope: null,
    });
  });

  it("pins null when the dir is missing", async () => {
    const { deps, kv, warnings } = setup({ sources: [workSource], dirs: [] });
    expect(await resolveClaudeEnv(deps, ctx)).toEqual([]);
    expect(kv.store.get("claude-config-dir:thr_1")).toEqual({
      dir: null,
      scope: null,
      reason: "missing-dir",
    });
    expect(warnings.join(" ")).toMatch(/not a directory/);
  });

  it("pins null and warns for an unresolved project", async () => {
    const { deps, kv, warnings } = setup({ sources: undefined });
    expect(await resolveClaudeEnv(deps, ctx)).toEqual([]);
    expect(kv.store.get("claude-config-dir:thr_1")).toEqual({
      dir: null,
      scope: null,
      reason: "unknown-project",
    });
    expect(warnings.join(" ")).toMatch(/bb dir-skills unpin thr_1/);
  });

  it("fails closed: still passes a pinned dir that is gone, and keeps the pin", async () => {
    const pin: ConfigDirPin = { dir: "/profiles/work", scope: "work" };
    const { deps, kv, warnings } = setup({
      sources: [workSource],
      dirs: [],
      kv: { "claude-config-dir:thr_1": pin },
    });
    const out = await resolveClaudeEnv(deps, ctx);
    expect(out.map((e) => e.value)).toEqual(["/profiles/work"]);
    expect(kv.store.get("claude-config-dir:thr_1")).toEqual(pin);
    expect(warnings.join(" ")).toMatch(/not a directory now/);
  });

  it("honours a null pin on a later turn even if the scope now matches", async () => {
    const pin: ConfigDirPin = { dir: null, scope: null, reason: "missing-dir" };
    const { deps, kv } = setup({
      sources: [workSource],
      dirs: ["/profiles/work"],
      kv: { "claude-config-dir:thr_1": pin },
    });
    expect(await resolveClaudeEnv(deps, ctx)).toEqual([]);
    expect(kv.store.get("claude-config-dir:thr_1")).toEqual(pin);
  });

  it("records why a null pin was written", async () => {
    const missing = setup({ sources: [workSource], dirs: [] });
    await resolveClaudeEnv(missing.deps, ctx);
    expect(missing.kv.store.get("claude-config-dir:thr_1")).toMatchObject({
      reason: "missing-dir",
    });
    const unknown = setup({ sources: undefined });
    await resolveClaudeEnv(unknown.deps, ctx);
    expect(unknown.kv.store.get("claude-config-dir:thr_1")).toMatchObject({
      reason: "unknown-project",
    });
    const none = setup({ sources: [{ path: "/p", hostId: SERVER }] });
    await resolveClaudeEnv(none.deps, ctx);
    expect(none.kv.store.get("claude-config-dir:thr_1")).toEqual({
      dir: null,
      scope: null,
    });
  });
});

describe("unpinThread", () => {
  it("removes a pin and warns about the earlier session", async () => {
    const kv = fakeKv({
      "claude-config-dir:thr_1": { dir: "/profiles/work", scope: "work" },
    });
    const out = await unpinThread(kv, "thr_1", undefined);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/removed pin \(\/profiles\/work, scope work\)/);
    expect(out.stdout).toMatch(/earlier Claude session stays in its previous profile/);
    expect(kv.store.has("claude-config-dir:thr_1")).toBe(false);
  });

  it("reports when there is no pin", async () => {
    const out = await unpinThread(fakeKv(), "thr_1", undefined);
    expect(out).toEqual({ exitCode: 0, stdout: "thread thr_1: no pin\n" });
  });

  it("defaults to the current thread", async () => {
    const kv = fakeKv({
      "claude-config-dir:thr_cur": { dir: null, scope: null },
    });
    const out = await unpinThread(kv, undefined, "thr_cur");
    expect(out.stdout).toMatch(/thread thr_cur: removed pin/);
    expect(kv.store.has("claude-config-dir:thr_cur")).toBe(false);
  });

  it("prefers an explicit id over the current thread", async () => {
    const kv = fakeKv({
      "claude-config-dir:thr_1": { dir: null, scope: null },
      "claude-config-dir:thr_cur": { dir: null, scope: null },
    });
    await unpinThread(kv, "thr_1", "thr_cur");
    expect(kv.store.has("claude-config-dir:thr_1")).toBe(false);
    expect(kv.store.has("claude-config-dir:thr_cur")).toBe(true);
  });

  it("rejects a flag-looking argument with usage", async () => {
    const out = await unpinThread(fakeKv(), "--json", "thr_cur");
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toMatch(/usage: bb dir-skills unpin/);
  });

  it("exits 2 with no id and no current thread", async () => {
    const out = await unpinThread(fakeKv(), undefined, undefined);
    expect(out.exitCode).toBe(2);
  });
});
