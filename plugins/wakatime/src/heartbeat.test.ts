import { describe, expect, it, vi } from "vitest";
import {
  APP_ENTITY,
  buildArgv,
  envInfoOf,
  entityFor,
  isExcluded,
  resolveContext,
  Throttle,
  THROTTLE_MS,
  TtlCache,
  unmatchedEntries,
} from "./heartbeat.js";
import type { ContextSdk, EnvInfo, ThreadLike } from "./heartbeat.js";

const PLUGIN = "bb/unknown bb-wakatime/0.1.0";

function thread(overrides: Partial<ThreadLike> = {}): ThreadLike {
  return {
    id: "thr_1",
    projectId: "prj_1",
    status: "active",
    title: "Fix login",
    titleFallback: "fallback",
    environmentId: "env_1",
    ...overrides,
  };
}

describe("buildArgv", () => {
  const spec = { entity: "Fix login", project: "acme", branch: "feat/x", category: "coding", timeMs: 1_700_000_000_123 };

  it("uses --flag=value form, seconds for --time, and always --sync-ai-disabled", () => {
    expect(buildArgv(spec, PLUGIN)).toEqual([
      "--entity-type=app",
      "--entity=Fix login",
      "--project=acme",
      "--alternate-branch=feat/x",
      "--category=coding",
      "--time=1700000000.123",
      `--plugin=${PLUGIN}`,
      "--sync-ai-disabled",
    ]);
  });

  it("never passes a key", () => {
    const argv = buildArgv(spec, PLUGIN);
    expect(argv.some((arg) => arg.startsWith("--key"))).toBe(false);
    expect(argv.every((arg) => arg.startsWith("--"))).toBe(true);
  });

  it("keeps a title starting with -- as the value of --entity", () => {
    const argv = buildArgv({ ...spec, entity: "--key=secret" }, PLUGIN);
    expect(argv[1]).toBe("--entity=--key=secret");
    expect(argv.filter((arg) => arg.startsWith("--key"))).toEqual([]);
  });

  it("collapses an embedded newline so the entity stays one line", () => {
    const argv = buildArgv({ ...spec, entity: "line one\nline two\r\n" }, PLUGIN);
    expect(argv[1]).toBe("--entity=line one line two");
    expect(argv.join("")).not.toMatch(/[\r\n]/);
  });

  it("strips bidi and zero-width format characters", () => {
    const argv = buildArgv({ ...spec, entity: "Fix\u202Eevil\u200B login\u2066", project: "ac\u200Cme" }, PLUGIN);
    expect(argv[1]).toBe("--entity=Fixevil login");
    expect(argv[2]).toBe("--project=acme");
    expect(argv.join("")).not.toMatch(/[\u200B-\u200C\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
  });

  it("adds --extra-heartbeats only when file entries follow on stdin", () => {
    expect(buildArgv(spec, PLUGIN)).not.toContain("--extra-heartbeats");
    expect(buildArgv(spec, PLUGIN, true)).toContain("--extra-heartbeats");
  });

  it("keeps U+200D so emoji sequences survive", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const argv = buildArgv({ ...spec, entity: `${family}\u200B work` }, PLUGIN);
    expect(argv[1]).toBe(`--entity=${family} work`);
  });

  it("cleans the editor string too", () => {
    const argv = buildArgv(spec, "bb/1.2\u202E.3\nbb-wakatime/0.1.0");
    expect(argv).toContain("--plugin=bb/1.2.3 bb-wakatime/0.1.0");
  });

  it("omits --project and --alternate-branch when absent", () => {
    const argv = buildArgv({ entity: APP_ENTITY, category: "coding", timeMs: 1000 }, PLUGIN);
    expect(argv.some((arg) => arg.startsWith("--project"))).toBe(false);
    expect(argv.some((arg) => arg.startsWith("--alternate-branch"))).toBe(false);
    expect(argv).toContain("--entity=bb");
  });

  it("falls back to bb when a value cleans away to nothing", () => {
    const argv = buildArgv({ entity: "\u0007", category: "", timeMs: 1000 }, "\u0007");
    expect(argv).toContain(`--entity=${APP_ENTITY}`);
    expect(argv).toContain("--category=coding");
    expect(argv).toContain(`--plugin=${APP_ENTITY}`);
  });
});

describe("entityFor", () => {
  it("falls back from title to titleFallback to the id", () => {
    expect(entityFor(thread(), "title")).toBe("Fix login");
    expect(entityFor(thread({ title: null }), "title")).toBe("fallback");
    expect(entityFor(thread({ title: "  ", titleFallback: null }), "title")).toBe("thr_1");
  });

  it("sends only the thread id in threadId mode, and bb with no thread", () => {
    expect(entityFor(thread(), "threadId")).toBe("thr_1");
    expect(entityFor(null, "title")).toBe(APP_ENTITY);
  });
});

describe("exclusion", () => {
  const project = { id: "prj_1", name: "acme" };

  it("matches by id or exact name", () => {
    expect(isExcluded(["prj_1"], project)).toBe(true);
    expect(isExcluded(["acme"], project)).toBe(true);
    expect(isExcluded(["Acme", "prj_2"], project)).toBe(false);
  });

  it("lists entries that match no project", () => {
    expect(unmatchedEntries(["prj_1", "gone", "acme"], [project])).toEqual(["gone"]);
  });
});

describe("Throttle", () => {
  const key = { key: "user", category: "coding" };

  it("allows one heartbeat per key and category every 120 s", () => {
    const throttle = new Throttle();
    expect(throttle.allow(key, "bb", "acme", 0)).toBe(true);
    expect(throttle.allow(key, "bb", "acme", THROTTLE_MS - 1)).toBe(false);
    expect(throttle.allow(key, "bb", "acme", THROTTLE_MS)).toBe(true);
    expect(throttle.allow({ ...key, category: "ai coding" }, "bb", "acme", THROTTLE_MS)).toBe(true);
  });

  it("lets an entity or project change through", () => {
    const throttle = new Throttle();
    throttle.allow(key, "a", "acme", 0);
    expect(throttle.allow(key, "b", "acme", 1)).toBe(true);
    expect(throttle.allow(key, "b", "other", 2)).toBe(true);
    expect(throttle.allow(key, "b", undefined, 3)).toBe(true);
    expect(throttle.allow(key, "b", undefined, 4)).toBe(false);
  });

  it("bypasses without recording, and forget drops a key", () => {
    const throttle = new Throttle();
    expect(throttle.allow(key, "a", "p", 0, true)).toBe(true);
    expect(throttle.size).toBe(0);
    throttle.allow(key, "a", "p", 0);
    expect(throttle.size).toBe(1);
    throttle.forget("user");
    expect(throttle.size).toBe(0);
    throttle.allow(key, "a", "p", 0);
    throttle.clear();
    expect(throttle.size).toBe(0);
  });
});

describe("TtlCache", () => {
  it("expires entries and drops them on the next write", () => {
    const cache = new TtlCache<string>(60_000);
    cache.set("a", "x", 0);
    expect(cache.get("a", 59_999)).toBe("x");
    expect(cache.get("a", 60_000)).toBeUndefined();
    cache.set("b", "y", 60_001);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("resolveContext", () => {
  function sdk(overrides: Partial<{
    thread: ThreadLike | Error;
    project: { id: string; name: string } | Error;
    branchName: string | null;
    currentBranch: string | null;
    outcome: string;
    envError: boolean;
  }> = {}) {
    const calls = { env: 0, status: 0 };
    const value = <T>(v: T | Error): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
    const api: ContextSdk = {
      threads: { get: async () => value(overrides.thread ?? thread()) },
      projects: { get: async () => value(overrides.project ?? { id: "prj_1", name: "acme" }) },
      environments: {
        get: async () => {
          calls.env++;
          if (overrides.envError) throw new Error("down");
          return {
            branchName: overrides.branchName === undefined ? "feat/x" : overrides.branchName,
            path: "/work/proj",
          };
        },
        status: async () => {
          calls.status++;
          return {
            outcome: overrides.outcome ?? "available",
            workspace: { branch: { currentBranch: overrides.currentBranch ?? null } },
          };
        },
      },
    };
    return { api, calls };
  }

  it("resolves thread, project and branch, deriving the project from the thread", async () => {
    const { api } = sdk();
    const ctx = await resolveContext(api, new TtlCache(60_000), { threadId: "thr_1" });
    expect(ctx?.thread?.id).toBe("thr_1");
    expect(ctx?.project?.name).toBe("acme");
    expect(ctx?.branch).toBe("feat/x");
  });

  it("returns an empty context for a view with no ids", async () => {
    const { api } = sdk();
    expect(await resolveContext(api, new TtlCache(60_000), {})).toEqual({ thread: null, project: null, branch: null });
  });

  it("resolves a project-only view", async () => {
    const { api } = sdk();
    const ctx = await resolveContext(api, new TtlCache(60_000), { projectId: "prj_1" });
    expect(ctx?.project?.name).toBe("acme");
    expect(ctx?.thread).toBeNull();
  });

  it("returns null when an id cannot be resolved", async () => {
    const cache = new TtlCache<EnvInfo>(60_000);
    expect(await resolveContext(sdk({ thread: new Error("404") }).api, cache, { threadId: "thr_x" })).toBeNull();
    expect(await resolveContext(sdk({ project: new Error("404") }).api, cache, { projectId: "prj_x" })).toBeNull();
  });

  it("uses a known thread instead of reading it again", async () => {
    const { api } = sdk({ thread: new Error("must not be read") });
    const ctx = await resolveContext(api, new TtlCache(60_000), { threadId: "thr_1" }, thread({ title: "Known" }));
    expect(ctx?.thread?.title).toBe("Known");
  });

  it("caches the branch for 60 s and falls back to the checked-out branch", async () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<EnvInfo>(60_000);
      const { api, calls } = sdk({ branchName: null, currentBranch: "main" });
      expect((await resolveContext(api, cache, { threadId: "thr_1" }))?.branch).toBe("main");
      await resolveContext(api, cache, { threadId: "thr_1" });
      expect(calls.env).toBe(1);
      vi.advanceTimersByTime(60_001);
      await resolveContext(api, cache, { threadId: "thr_1" });
      expect(calls.env).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives no branch when the environment is unavailable, and does not cache a failure", async () => {
    const cache = new TtlCache<EnvInfo>(60_000);
    expect((await resolveContext(sdk({ branchName: null, outcome: "unavailable" }).api, cache, { threadId: "t" }))?.branch).toBeNull();
    const failing = sdk({ envError: true });
    expect((await resolveContext(failing.api, new TtlCache(60_000), { threadId: "t" }))?.branch).toBeNull();
    const fresh = new TtlCache<EnvInfo>(60_000);
    await resolveContext(failing.api, fresh, { threadId: "t" });
    expect(fresh.size).toBe(0);
  });

  it("skips the branch lookup for a thread with no environment", async () => {
    const { api, calls } = sdk({ thread: thread({ environmentId: null }) });
    expect((await resolveContext(api, new TtlCache(60_000), { threadId: "thr_1" }))?.branch).toBeNull();
    expect(calls.env).toBe(0);
  });
});

describe("envInfoOf", () => {
  function environments(overrides: {
    getFailures?: number;
    statusError?: boolean;
    branchName?: string | null;
    currentBranch?: string | null;
  }) {
    let failures = overrides.getFailures ?? 0;
    const calls = { get: 0, status: 0 };
    const api = {
      async get() {
        calls.get++;
        if (failures > 0) {
          failures--;
          throw new Error("down");
        }
        return { branchName: overrides.branchName === undefined ? null : overrides.branchName, path: "/work/proj" };
      },
      async status() {
        calls.status++;
        if (overrides.statusError) throw new Error("git down");
        return { outcome: "available", workspace: { branch: { currentBranch: overrides.currentBranch ?? null } } };
      },
    };
    return { api, calls };
  }

  it("keeps the folder, and caches nothing, when only the branch fallback fails", async () => {
    const cache = new TtlCache<EnvInfo>(60_000);
    const { api, calls } = environments({ statusError: true });
    expect(await envInfoOf(api, cache, "env_1")).toEqual({ branch: null, path: "/work/proj" });
    expect(cache.size).toBe(0);
    await envInfoOf(api, cache, "env_1");
    expect(calls.get).toBe(2);
  });

  it("is null, and caches nothing, when the environment itself cannot be read; the next read recovers", async () => {
    const cache = new TtlCache<EnvInfo>(60_000);
    const { api } = environments({ getFailures: 1, branchName: "feat/x" });
    expect(await envInfoOf(api, cache, "env_1")).toBeNull();
    expect(cache.size).toBe(0);
    expect(await envInfoOf(api, cache, "env_1")).toEqual({ branch: "feat/x", path: "/work/proj" });
    expect(cache.size).toBe(1);
  });

  it("caches a null branch when the host has no checked-out branch to report", async () => {
    const cache = new TtlCache<EnvInfo>(60_000);
    const { api } = environments({ branchName: null, currentBranch: null });
    expect(await envInfoOf(api, cache, "env_1")).toEqual({ branch: null, path: "/work/proj" });
    expect(cache.size).toBe(1);
  });
});
