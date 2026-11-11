import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkClaudeProfile,
  claudeProfileLines,
  decidePin,
  isDirectory,
  resolveClaudeEnv,
  unpinThread,
  warnMissingConfigDirs,
  withTimeout,
  type ClaudeProfileDeps,
  type ConfigDirPin,
} from "./profile.js";
import type { ProfileScope, ProfilesState } from "./profiles-file.js";
import type { ProjectSource } from "./projects.js";

function scope(name: string, root: string, claudeConfigDir: string): ProfileScope {
  return { name, paths: [root], claudeConfigDir };
}

const valid = (scopes: ProfileScope[]): ProfilesState => ({ state: "valid", scopes });

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
    async list(prefix?: string) {
      return [...store.keys()].filter((key) => key.startsWith(prefix ?? ""));
    },
  };
}

function throwingKv() {
  return {
    get: async () => {
      throw new Error("kv.get must not be called");
    },
    set: async () => {
      throw new Error("kv.set must not be called");
    },
    delete: async () => {
      throw new Error("kv.delete must not be called");
    },
    list: async () => {
      throw new Error("kv.list must not be called");
    },
  };
}

function setup(opts: {
  scopes?: ProfileScope[];
  profiles?: ProfilesState;
  sources?: ProjectSource[] | undefined;
  dirs?: string[];
  kv?: Record<string, unknown>;
}) {
  const kv = fakeKv(opts.kv);
  const warnings: string[] = [];
  const debugs: string[] = [];
  const deps: ClaudeProfileDeps = {
    profiles: opts.profiles ?? valid(opts.scopes ?? [work]),
    log: {
      debug: (m: string) => void debugs.push(m),
      warn: (m: string) => void warnings.push(m),
    },
    kv,
    isDir: (p) => (opts.dirs ?? ["/profiles/work"]).includes(p),
    sourcesFor: async () => opts.sources,
  };
  return { deps, kv, warnings, debugs };
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

describe("the first profile scope by name wins, whatever the order in the file", () => {
  it.each([
    ["a-other first", () => [scope("a-other", "/w", "/profiles/other"), work]],
    ["work first", () => [work, scope("a-other", "/w", "/profiles/other")]],
  ])("%s", (_label, scopes) => {
    const d = decidePin(scopes(), [workSource], SERVER, () => true);
    expect(d.pin.scope).toBe("a-other");
    expect(d.conflict).toEqual(["work"]);
  });
});

describe("warnMissingConfigDirs", () => {
  it("warns only for scopes whose claudeConfigDir is not a directory", () => {
    const warnings: string[] = [];
    const real = mkdtempSync(path.join(tmpdir(), "model-instructions-warn-"));
    try {
      warnMissingConfigDirs(
        [
          scope("work", "/w", "/profiles/gone"),
          scope("ok", "/o", real),
        ],
        { warn: (m: string) => void warnings.push(m) },
      );
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
    expect(warnings).toEqual([
      'profile scope "work" claudeConfigDir /profiles/gone is not a directory; threads there start with the default profile',
    ]);
  });
});

describe("withTimeout", () => {
  it("returns as soon as the task settles", async () => {
    let done = false;
    await withTimeout(
      (async () => {
        done = true;
      })(),
      5_000,
    );
    expect(done).toBe(true);
  });

  it("returns when the timeout wins over a never-settling task", async () => {
    await withTimeout(new Promise<void>(() => {}), 1);
  });
});

describe("isDirectory", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "model-instructions-profile-"));
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
  const hint = "run `bb model-instructions unpin";

  it("says a project is needed when there is none", () => {
    expect(claudeProfileLines(valid([work]), null, null, undefined)).toEqual([
      "Claude profile: needs --project",
    ]);
  });

  it("shows the profile and scope", () => {
    const d = decidePin([work], [workSource], SERVER, () => true);
    const text = claudeProfileLines(valid([work]), d, null, undefined).join("\n");
    expect(text).toMatch(/\/profiles\/work {2}\(scope work\)/);
    expect(text).not.toMatch(/unpin/);
  });

  it("names the configured dir and scope for a missing dir, with the hint", () => {
    const d = decidePin([work], [workSource], SERVER, () => false);
    const text = claudeProfileLines(valid([work]), d, null, undefined).join("\n");
    expect(text).toMatch(/scope work sets \/profiles\/work, which is not a directory/);
    expect(text).toContain(hint);
  });

  it("labels an unknown project with the hint", () => {
    const d = decidePin([work], undefined, null, () => true);
    const text = claudeProfileLines(valid([work]), d, null, undefined).join("\n");
    expect(text).toMatch(/unknown project/);
    expect(text).toContain(hint);
  });

  it("shows a null pin's reason and the unpin hint for the thread", () => {
    const d = decidePin([work], [workSource], SERVER, () => true);
    const text = claudeProfileLines(
      valid([work]),
      d,
      { dir: null, scope: null, reason: "unknown-project" },
      "thr_9",
    ).join("\n");
    expect(text).toMatch(/pinned for thread thr_9: none \(default profile: project not resolved;/);
    expect(text).toContain("unpin thr_9");
  });

  it("lists conflicting scopes", () => {
    const other = scope("a-other", "/w", "/profiles/other");
    const d = decidePin([work, other], [workSource], SERVER, () => true);
    const text = claudeProfileLines(valid([work]), d, null, undefined).join("\n");
    expect(text).toContain("conflicts with scope(s): work");
  });

  it("says the thread is not pinned yet", () => {
    const d = decidePin([work], [workSource], SERVER, () => true);
    const text = claudeProfileLines(valid([work]), d, null, "thr_9").join("\n");
    expect(text).toContain("pinned for thread thr_9: not pinned yet");
  });

  it("shows a plain default profile for a null pin without a reason", () => {
    const d = decidePin([work], [workSource], SERVER, () => true);
    const text = claudeProfileLines(
      valid([work]),
      d,
      { dir: null, scope: null },
      "thr_9",
    ).join("\n");
    expect(text).toContain("pinned for thread thr_9: none (default profile)");
    expect(text).not.toContain("unpin");
  });
});

describe("checkClaudeProfile", () => {
  it("reports nothing without a project or thread", async () => {
    const { deps } = setup({ sources: [workSource] });
    expect(await checkClaudeProfile(deps, null, undefined)).toEqual({
      decision: null,
      pinned: null,
    });
  });

  it("decides by project across all hosts and reads the thread pin", async () => {
    const { deps } = setup({
      sources: [{ path: "/w/repo", hostId: REMOTE }],
      kv: {
        "claude-config-dir:thr_1": { dir: "/profiles/work", scope: "work" },
      },
    });
    const { decision, pinned } = await checkClaudeProfile(
      deps,
      "proj_1",
      "thr_1",
    );
    expect(decision).toMatchObject({
      status: "profile",
      pin: { dir: "/profiles/work", scope: "work" },
    });
    expect(pinned).toEqual({ dir: "/profiles/work", scope: "work" });
  });

  it("leaves the pin out when only a project is given", async () => {
    const { deps } = setup({ sources: [workSource] });
    const { decision, pinned } = await checkClaudeProfile(
      deps,
      "proj_1",
      undefined,
    );
    expect(decision?.status).toBe("profile");
    expect(pinned).toBeNull();
  });

  it("leaves the decision out when only a thread is given", async () => {
    const { deps } = setup({});
    expect(await checkClaudeProfile(deps, null, "thr_1")).toEqual({
      decision: null,
      pinned: null,
    });
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
        reason: 'model-instructions profile scope "work"',
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
    expect(warnings.join(" ")).toMatch(/bb model-instructions unpin thr_1/);
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

  // Where learned: @get-bb/plugin-sdk 0.6.79 made threadId/projectId on
  // ExperimentalPluginProviderEnvContext nullable ("null when bb resolves the
  // environment for a provider process that serves no thread, such as model
  // catalog listing", packages/plugin-sdk in get-bb/bb, bundled-types
  // bb-plugin-sdk.d.ts).
  it("skips the pin store and uses the default profile when there is no thread and no project", async () => {
    const { deps, warnings, debugs } = setup({ sources: undefined });
    deps.kv = throwingKv();
    const out = await resolveClaudeEnv(deps, {
      ...ctx,
      threadId: null,
      projectId: null,
    });
    expect(out).toEqual([]);
    expect(debugs).toHaveLength(1);
    expect(debugs[0]).toContain(SERVER);
    expect(debugs[0]).toMatch(
      /provider process without a thread, no pin -> default profile/,
    );
    expect(warnings).toEqual([]);
  });

  it("skips the pin store but still resolves by project when there is no thread", async () => {
    const { deps, debugs } = setup({ sources: [workSource] });
    deps.kv = throwingKv();
    const asked: string[] = [];
    const sourcesFor = deps.sourcesFor;
    deps.sourcesFor = async (projectId) => {
      asked.push(projectId);
      return sourcesFor(projectId);
    };
    const out = await resolveClaudeEnv(deps, { ...ctx, threadId: null });
    expect(asked).toEqual(["proj_1"]);
    expect(out).toEqual([
      {
        name: "CLAUDE_CONFIG_DIR",
        value: "/profiles/work",
        reason: 'model-instructions profile scope "work"',
      },
    ]);
    expect(debugs).toHaveLength(1);
  });

  it("warns about conflicting scopes even without a thread", async () => {
    const other = scope("a-other", "/w", "/profiles/other");
    const { deps, warnings, debugs } = setup({
      scopes: [work, other],
      sources: [workSource],
      dirs: ["/profiles/other", "/profiles/work"],
    });
    deps.kv = throwingKv();
    const out = await resolveClaudeEnv(deps, { ...ctx, threadId: null });
    expect(out.map((e) => e.value)).toEqual(["/profiles/other"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^project proj_1 provider process without a thread: /,
    );
    expect(warnings[0]).toMatch(/different claudeConfigDir/);
    expect(debugs).toHaveLength(1);
  });

  it("honours the pin for a real thread even when the project is null", async () => {
    const pin: ConfigDirPin = { dir: "/profiles/other", scope: "x" };
    const { deps, kv } = setup({
      sources: [workSource],
      dirs: ["/profiles/other", "/profiles/work"],
      kv: { "claude-config-dir:thr_1": pin },
    });
    const out = await resolveClaudeEnv(deps, { ...ctx, projectId: null });
    expect(out.map((e) => e.value)).toEqual(["/profiles/other"]);
    expect(kv.store.get("claude-config-dir:thr_1")).toEqual(pin);
  });

  it("pins null and warns for a null project on a real thread", async () => {
    const { deps, kv, warnings } = setup({ sources: [workSource] });
    expect(await resolveClaudeEnv(deps, { ...ctx, projectId: null })).toEqual(
      [],
    );
    expect(kv.store.get("claude-config-dir:thr_1")).toEqual({
      dir: null,
      scope: null,
      reason: "unknown-project",
    });
    expect(warnings.join(" ")).toMatch(/project none not resolved/);
    expect(warnings.join(" ")).toMatch(/bb model-instructions unpin thr_1/);
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
    expect(out.stderr).toMatch(/usage: bb model-instructions unpin/);
  });

  it("exits 2 with no id and no current thread", async () => {
    const out = await unpinThread(fakeKv(), undefined, undefined);
    expect(out.exitCode).toBe(2);
  });
});

describe("the profiles.json state decides whether a new pin is written", () => {
  const states: Array<[string, ProfilesState]> = [
    ["absent", { state: "absent" }],
    ["malformed", { state: "malformed", message: "not valid JSON" }],
    ["valid", valid([work])],
  ];
  const pin: ConfigDirPin = { dir: "/profiles/other", scope: "x" };
  const nullPin: ConfigDirPin = { dir: null, scope: null, reason: "missing-dir" };

  describe.each(states)("%s", (name, profiles) => {
    it("serves an existing pin first, even when its dir is gone, and writes nothing", async () => {
      const { deps, kv, warnings } = setup({ profiles, sources: [workSource], dirs: [], kv: { "claude-config-dir:thr_1": pin } });
      const out = await resolveClaudeEnv(deps, ctx);
      expect(out.map((e) => e.value)).toEqual(["/profiles/other"]);
      expect(kv.store.get("claude-config-dir:thr_1")).toEqual(pin);
      expect(warnings.join(" ")).toMatch(/pinned to \/profiles\/other, which is not a directory now/);
    });

    it("serves an existing null pin and keeps it", async () => {
      const { deps, kv } = setup({ profiles, sources: [workSource], kv: { "claude-config-dir:thr_1": nullPin } });
      expect(await resolveClaudeEnv(deps, ctx)).toEqual([]);
      expect(kv.store.get("claude-config-dir:thr_1")).toEqual(nullPin);
    });

    it("pins a thread without a pin only while the file is valid", async () => {
      const { deps, kv } = setup({ profiles, sources: [workSource] });
      const out = await resolveClaudeEnv(deps, ctx);
      if (name === "valid") {
        expect(out.map((e) => e.value)).toEqual(["/profiles/work"]);
        expect(kv.store.get("claude-config-dir:thr_1")).toEqual({ dir: "/profiles/work", scope: "work" });
      } else {
        expect(out).toEqual([]);
        expect(kv.store.size).toBe(0);
      }
    });

    it("never touches the pin store or the project list for a process with no thread unless the file is valid", async () => {
      const { deps, debugs } = setup({ profiles, sources: [workSource] });
      deps.kv = throwingKv();
      const asked: string[] = [];
      deps.sourcesFor = async (id) => {
        asked.push(id);
        return [workSource];
      };
      const out = await resolveClaudeEnv(deps, { ...ctx, threadId: null });
      expect(out.map((e) => e.value)).toEqual(name === "valid" ? ["/profiles/work"] : []);
      expect(asked).toEqual(name === "valid" ? ["proj_1"] : []);
      expect(debugs).toHaveLength(1);
      if (name !== "valid") expect(debugs[0]).toContain(`profiles.json ${name}`);
    });

    it("does not resolve the project or write for an unpinned thread in a state that cannot decide", async () => {
      const { deps, debugs } = setup({ profiles, sources: [workSource] });
      let looked = 0;
      deps.sourcesFor = async () => {
        looked += 1;
        return [workSource];
      };
      await resolveClaudeEnv(deps, ctx);
      expect(looked).toBe(name === "valid" ? 1 : 0);
      if (name !== "valid") expect(debugs.join(" ")).toContain(`profiles.json ${name}, not pinned`);
    });
  });

  it("check reports no decision unless the file is valid, and still reads the pin", async () => {
    for (const [name, profiles] of states) {
      const { deps } = setup({ profiles, sources: [workSource], kv: { "claude-config-dir:thr_1": pin } });
      const { decision, pinned } = await checkClaudeProfile(deps, "proj_1", "thr_1");
      expect(decision === null).toBe(name !== "valid");
      expect(pinned).toEqual(pin);
    }
  });

  it("explains an absent and a malformed file in the check lines, and still shows the pin", () => {
    expect(claudeProfileLines({ state: "absent" }, null, null, undefined)).toEqual([
      "Claude profile: none (profiles.json is absent; a thread without a pin gets no CLAUDE_CONFIG_DIR and no pin is written)",
    ]);
    const lines = claudeProfileLines({ state: "malformed", message: "bad" }, null, pin, "thr_1");
    expect(lines[0]).toBe("Claude profile: none (profiles.json: malformed — bad; no new pin is written)");
    expect(lines[1]).toBe("Claude profile pinned for thread thr_1: /profiles/other");
  });
});

describe("only profile scopes decide", () => {
  it("uses the scopes the dependency carries and nothing else: a scope's paths move the decision", () => {
    const moved = scope("work", "/elsewhere", "/profiles/work");
    expect(decidePin([moved], [workSource], SERVER, () => true).status).toBe("none");
    expect(decidePin([work], [workSource], SERVER, () => true).status).toBe("profile");
  });
});
