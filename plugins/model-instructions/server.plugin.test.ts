import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { omittedNotice } from "./src/rules.js";
import plugin from "./server.js";

const x = (length: number) => "x".repeat(length);

let base: string;
let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "model-instructions-server-")));
  home = path.join(base, "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(base, { recursive: true, force: true });
  vi.doUnmock("node:url");
  vi.resetModules();
  vi.useRealTimers();
});

afterAll(() => {
  vi.doUnmock("node:url");
});

/** What the fake bb knows about: provider → models, and projects with their checkouts. */
interface World {
  providers: Record<string, string[]>;
  projects: Array<{ id: string; name: string; sources?: Array<{ path?: string; hostId?: string }> }>;
}

function sdkFor(world: World) {
  return {
    providers: {
      list: async () =>
        Object.keys(world.providers).map((id) => ({ id, available: true })),
      models: async ({ providerId }: { providerId: string }) => ({
        models: world.providers[providerId].map((model) => ({ id: model, model })),
        modelLoadError: null,
      }),
    },
    projects: { list: async () => world.projects },
  };
}

const DEFAULT_WORLD = (): World => ({
  providers: { "claude-code": ["opus"] },
  projects: [{ id: "proj_1", name: "bb-plugins", sources: [] }],
});

function skillsRoot(names: string[]): string {
  const root = path.join(base, "plugin");
  for (const name of names) {
    const dir = path.join(root, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture ${name}\n---\nbody`);
  }
  return root;
}

/** Loads server.ts as if it lived in `root`, so the bundled skills come from a fixture directory. */
async function pluginAt(root: string, file = "server.ts") {
  vi.resetModules();
  vi.doMock("node:url", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:url")>();
    return { ...actual, fileURLToPath: () => path.join(root, file) };
  });
  return (await import("./server.js")).default;
}

interface HostOptions {
  settings?: Record<string, string>;
  world?: World;
  sdk?: Record<string, unknown>;
  skills?: string[];
  root?: string;
  file?: string;
}

async function load(options: HostOptions = {}) {
  const world = options.world ?? DEFAULT_WORLD();
  const skills = options.skills ?? ["work-conventions", "other"];
  const host = createFakePluginHost({
    pluginId: "model-instructions",
    agentSkillIds: ["model-instructions", ...skills],
    settings: options.settings,
    sdk: { ...sdkFor(world), ...options.sdk },
  });
  const root = options.root ?? skillsRoot(["model-instructions", ...skills]);
  const create = await pluginAt(root, options.file);
  await create(host.bb);
  return { host, harness: host.harness, world };
}

function configure(
  harness: Awaited<ReturnType<typeof load>>["harness"],
  over: {
    model?: string;
    provider?: string;
    parent?: string | null;
    project?: { id?: string; name?: string };
    path?: string | null;
    thread?: string;
    title?: string | null;
  } = {},
) {
  return harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: over.thread ?? "thr_1", parentThreadId: over.parent ?? null, title: over.title ?? null },
      project: { id: "proj_1", name: "bb-plugins", ...over.project },
      environment: { path: over.path === null ? undefined : (over.path ?? "/tmp/none") },
      provider: { id: over.provider ?? "claude-code", model: over.model ?? "opus" },
    }),
  );
}

const warnings = (harness: { logEntries: Array<{ level: string; message: string }> }) =>
  harness.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message);

const rules = (...list: unknown[]) => JSON.stringify(list);

describe("skills through the plugin", () => {
  it("injects only model-instructions and no instructions with the default setting", async () => {
    const { harness } = await load();
    expect(await configure(harness)).toEqual({
      tools: [],
      skills: ["model-instructions"],
      instructions: null,
    });
  });

  it("injects a skill claimed by a matching rule, once, however many rules claim it", async () => {
    const { harness } = await load({
      settings: {
        rules: rules(
          { skills: "work-*" },
          { skills: ["work-conventions", "other"], instructions: "x" },
          { skills: "*" },
        ),
      },
    });
    const configured = await configure(harness);
    expect(configured.skills).toEqual(["model-instructions", "other", "work-conventions"]);
    expect(configured.instructions).toBe("x");
  });

  it("injects an unclaimed bundled skill nowhere", async () => {
    const { harness } = await load({ settings: { rules: rules({ skills: "other" }) } });
    expect((await configure(harness)).skills).toEqual(["model-instructions", "other"]);
  });

  it("gives a scope-gated skill only to threads inside the scope", async () => {
    const root = path.join(base, "repos", "acme");
    mkdirSync(path.join(root, "app"), { recursive: true });
    const world = DEFAULT_WORLD();
    world.projects = [
      { id: "proj_in", name: "in", sources: [{ path: path.join(root, "app"), hostId: "h" }] },
      { id: "proj_out", name: "out", sources: [{ path: path.join(base, "other") }] },
    ];
    const { harness } = await load({
      world,
      settings: {
        rules: JSON.stringify({
          scopes: [{ name: "work", paths: [root] }],
          rules: [{ scope: "work", skills: "work-*", instructions: "work rule" }],
        }),
      },
    });
    const inside = await configure(harness, { project: { id: "proj_in" }, path: null });
    expect(inside).toMatchObject({
      skills: ["model-instructions", "work-conventions"],
      instructions: "work rule",
    });
    const byPath = await configure(harness, { project: { id: "proj_out" }, path: path.join(root, "app") });
    expect(byPath.skills).toEqual(["model-instructions", "work-conventions"]);
    const outside = await configure(harness, { project: { id: "proj_out" }, path: null });
    expect(outside).toMatchObject({ skills: ["model-instructions"], instructions: null });
    const unknownProject = await configure(harness, { project: { id: "proj_gone" }, path: null });
    expect(unknownProject.skills).toEqual(["model-instructions"]);
  });

  it("expands ~/ scope paths against the user's home", async () => {
    mkdirSync(path.join(home, "work", "app"), { recursive: true });
    const { harness } = await load({
      settings: {
        rules: JSON.stringify({
          scopes: [{ name: "w", paths: ["~/work"] }],
          rules: [{ scope: "w", instructions: "home scope" }],
        }),
      },
    });
    expect((await configure(harness, { path: path.join(home, "work", "app") })).instructions).toBe("home scope");
    expect((await configure(harness, { path: path.join(home, "play") })).instructions).toBeNull();
  });

  it("keeps working when the bundled skills cannot be read", async () => {
    const { harness } = await load({
      root: path.join(base, "no-plugin-here"),
      settings: { rules: rules({ instructions: "still here" }) },
    });
    expect(warnings(harness).some((line) => line.startsWith("bundled skills not loaded: "))).toBe(true);
    expect(await configure(harness)).toMatchObject({ skills: ["model-instructions"], instructions: "still here" });
  });

  it("stringifies a non-error skills failure", async () => {
    vi.resetModules();
    vi.doMock("./src/skills.js", () => ({
      loadSkills: () => {
        throw "boom-string";
      },
    }));
    try {
      const create = (await import("./server.js")).default;
      const host = createFakePluginHost({
        pluginId: "model-instructions",
        agentSkillIds: ["model-instructions"],
        sdk: sdkFor(DEFAULT_WORLD()),
      });
      await create(host.bb);
      expect(warnings(host.harness)).toContain("bundled skills not loaded: boom-string");
    } finally {
      vi.doUnmock("./src/skills.js");
    }
  });

  it("finds the skills above a dist directory", async () => {
    const root = skillsRoot(["model-instructions", "work-conventions"]);
    const { harness } = await load({
      root: path.join(root, "dist"),
      file: "server.js",
      skills: ["work-conventions"],
      settings: { rules: rules({ skills: "work-*" }) },
    });
    expect((await configure(harness)).skills).toEqual(["model-instructions", "work-conventions"]);
  });
});

describe("the setting: save checks and load", () => {
  it("rejects an unknown scope glob and an unknown skills glob on save", async () => {
    const { harness } = await load();
    await expect(
      harness.setSettings({ rules: rules({ name: "gchat", scope: "work", instructions: "x" }) }),
    ).rejects.toThrow('gchat: scope "work" matches no defined scope');
    await expect(harness.setSettings({ rules: rules({ skills: "typo-*" }) })).rejects.toThrow(
      'rules[0]: skills "typo-*" matches no bundled skill',
    );
  });

  it("accepts known scope and skills globs on save", async () => {
    const { harness } = await load();
    await harness.setSettings({
      rules: JSON.stringify({
        scopes: [{ name: "work", paths: ["/work"] }],
        rules: [{ scope: "work", skills: "work-*", instructions: "x" }],
      }),
    });
    expect((await configure(harness, { path: "/work/app" })).skills).toEqual([
      "model-instructions",
      "work-conventions",
    ]);
  });

  it("accepts the object form without vars and keeps the array form unchanged", async () => {
    const { harness } = await load();
    await harness.setSettings({ rules: JSON.stringify({ rules: [{ instructions: "no vars" }] }) });
    expect((await configure(harness)).instructions).toBe("no vars");
    await harness.setSettings({ rules: rules({ instructions: "{{literal}} array" }) });
    expect((await configure(harness)).instructions).toBe("{{literal}} array");
  });

  it("loads the same unknown references from storage, with one warning per rule and nothing disabled", async () => {
    const { harness } = await load({
      settings: {
        rules: rules(
          { name: "guard", instructions: "keep me" },
          { name: "gone-scope", scope: ["work", "also-gone"], skills: ["nope-*"], instructions: "never" },
          { skills: "typo" },
        ),
      },
    });
    expect(warnings(harness).filter((line) => line.includes("match nothing"))).toEqual([
      'gone-scope: scope "work", scope "also-gone", skills "nope-*" match nothing',
      'rules[2]: skills "typo" match nothing',
    ]);
    expect(await configure(harness)).toMatchObject({ instructions: "keep me", skills: ["model-instructions"] });
  });

  it("loads a stored value that overflows, without failing the setting", async () => {
    const { harness } = await load({ settings: { rules: rules({ instructions: x(3000) }, { instructions: x(3000) }) } });
    expect((await configure(harness)).instructions).toBe(`${x(3000)}\n\n${omittedNotice(1)}`);
  });

  it("rejects an overflowing value on save with the grouped message, and accepts one under the limit", async () => {
    const world = DEFAULT_WORLD();
    world.providers = { "claude-code": ["opus", "sonnet"], codex: ["gpt"] };
    world.projects = [
      { id: "p1", name: "alpha" },
      { id: "p2", name: "beta" },
    ];
    const { harness } = await load({ world });
    await expect(
      harness.setSettings({ rules: rules({ name: "a", instructions: x(2500) }, { name: "b", instructions: x(2500) }) }),
    ).rejects.toThrow(/over the 4096-character limit with a, b:\n {2}claude-code opus top-level project "alpha": 5002/);
    await expect(
      harness.setSettings({ rules: rules({ name: "a", instructions: x(2500) }, { name: "b", instructions: x(2500) }) }),
    ).rejects.toThrow("and 13 more");
    await harness.setSettings({ rules: rules({ instructions: x(2000) }, { instructions: x(2000) }) });
    expect((await configure(harness)).instructions).toBe(`${x(2000)}\n\n${x(2000)}`);
  });

  it("rejects a value with text while a list is not loaded or its last refresh failed, and accepts it after a retry", async () => {
    const world = DEFAULT_WORLD();
    let projectsFail = true;
    let providersFail = true;
    const { harness } = await load({
      world,
      sdk: {
        projects: { list: async () => { if (projectsFail) throw new Error("projects down"); return world.projects; } },
        providers: {
          list: async () => { if (providersFail) throw new Error("providers down"); return [{ id: "claude-code", available: true }]; },
          models: async () => ({ models: [{ id: "opus", model: "opus" }], modelLoadError: null }),
        },
      },
    });
    await expect(harness.setSettings({ rules: rules({ instructions: "x" }) })).rejects.toThrow(
      "budget not checkable yet: provider list not loaded; retry",
    );
    expect(warnings(harness)).toContain("provider list refresh failed: providers down");
    expect(warnings(harness)).toContain("project list refresh failed: projects down");
    providersFail = false;
    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_x" }) });
    await vi.waitFor(async () =>
      expect(harness.sdk.callsTo("providers.list").length).toBeGreaterThan(1),
    );
    await vi.waitFor(async () =>
      await expect(harness.setSettings({ rules: rules({ instructions: "x" }) })).rejects.toThrow(
        "budget not checkable yet: project list not loaded; retry",
      ),
    );
    projectsFail = false;
    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_y" }) });
    await vi.waitFor(async () => {
      await harness.setSettings({ rules: rules({ instructions: "now fine" }) });
    });
    expect((await configure(harness)).instructions).toBe("now fine");
    // A later failure keeps the data but makes the budget uncheckable again.
    projectsFail = true;
    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_z" }) });
    await vi.waitFor(async () =>
      await expect(harness.setSettings({ rules: rules({ instructions: "again" }) })).rejects.toThrow(
        "project list not loaded",
      ),
    );
  });

  it("follows a setting change without a reload and clears stale over-budget records", async () => {
    const { harness } = await load({ settings: { rules: rules({ instructions: x(3000) }, { instructions: x(3000) }) } });
    expect(JSON.parse((await harness.runCli(["status", "--json"])).stdout).overBudget).not.toEqual([]);
    await harness.setSettings({ rules: rules({ instructions: "small" }) });
    expect(JSON.parse((await harness.runCli(["status", "--json"])).stdout).overBudget).toEqual([]);
  });
});

describe("rules left out at runtime", () => {
  const OVERFLOW = rules(
    { name: "guard", instructions: x(3000) },
    { name: "extra", instructions: x(1500) },
  );

  it("warns once per thread and set of dropped rules", async () => {
    const { harness } = await load({ settings: { rules: OVERFLOW } });
    const lost = () => warnings(harness).filter((line) => line.includes("lost rules"));
    await configure(harness, { thread: "thr_a" });
    await configure(harness, { thread: "thr_a" });
    expect(lost()).toEqual([
      "thread thr_a (claude-code opus, top-level) lost rules over the limit: extra",
    ]);
    await configure(harness, { thread: "thr_b", parent: "thr_a" });
    await configure(harness, { thread: "thr_b", parent: "thr_a" });
    expect(lost()).toHaveLength(2);
    expect(lost()[1]).toContain("thr_b (claude-code opus, child)");
  });

  it("warns again for the same thread when the dropped set changes", async () => {
    const { harness } = await load({
      settings: { rules: rules({ name: "g", instructions: x(3000) }, { name: "m", model: "other-*", instructions: x(1200) }, { name: "e", instructions: x(1500) }) },
    });
    await configure(harness, { thread: "thr_a", model: "opus" });
    await configure(harness, { thread: "thr_a", model: "other-1" });
    await configure(harness, { thread: "thr_a", model: "opus" });
    expect(warnings(harness).filter((line) => line.includes("lost rules")).map((line) => line.split(": ").pop())).toEqual([
      "e",
      "m, e",
    ]);
  });

  it("returns the kept text with the notice and all the skills", async () => {
    const { harness } = await load({
      settings: { rules: rules({ instructions: x(3000) }, { skills: "other", instructions: x(1500) }) },
    });
    const configured = await configure(harness);
    expect(configured.instructions).toBe(`${x(3000)}\n\n${omittedNotice(1)}`);
    expect(configured.skills).toEqual(["model-instructions", "other"]);
  });

  it("keeps the last 20 events with names and lengths, never the text", async () => {
    const { harness } = await load({ settings: { rules: OVERFLOW } });
    for (let i = 0; i < 22; i += 1) await configure(harness, { thread: `thr_${i}`, title: "t" });
    const { overflowEvents } = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
    expect(overflowEvents).toHaveLength(20);
    expect(overflowEvents[0].threadId).toBe("thr_2");
    expect(overflowEvents[19]).toMatchObject({
      threadId: "thr_21",
      provider: "claude-code",
      model: "opus",
      role: "top-level",
      project: "bb-plugins",
      dropped: ["extra"],
      lengths: [1500],
    });
    expect(overflowEvents[19].time).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(JSON.stringify(overflowEvents)).not.toContain("xxx");
    const text = (await harness.runCli(["status"])).stdout;
    expect(text).toContain("thr_21 claude-code opus top-level project \"bb-plugins\": extra (1500 chars)");
  });

  it("records a child thread's role and a thread with no project", async () => {
    const { harness } = await load({ settings: { rules: OVERFLOW } });
    await configure(harness, { thread: "thr_c", parent: "thr_p", project: { name: "" } });
    const text = (await harness.runCli(["status"])).stdout;
    expect(text).toContain("thr_c claude-code opus child project (none): extra (1500 chars)");
  });
});

describe("the cache refresh and the budget re-check", () => {
  const NEW_MODEL_ONLY = rules(
    { name: "a", model: "new-*", instructions: x(3000) },
    { name: "b", model: "new-*", instructions: x(3000) },
  );

  async function refreshed(harness: Awaited<ReturnType<typeof load>>["harness"]) {
    const before = harness.sdk.callsTo("providers.list").length;
    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_new" }) });
    await vi.waitFor(() => expect(harness.sdk.callsTo("providers.list").length).toBeGreaterThan(before));
    // the re-check runs after both lists settle
    await vi.waitFor(async () => {
      expect(harness.sdk.callsTo("projects.list").length).toBeGreaterThan(before);
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  it("flags a refresh that adds an overflowing model, and logs each new type once", async () => {
    const { harness, world } = await load({ settings: { rules: NEW_MODEL_ONLY } });
    expect(JSON.parse((await harness.runCli(["status", "--json"])).stdout).overBudget).toEqual([]);
    expect(warnings(harness).filter((line) => line.startsWith("over budget"))).toEqual([]);

    world.providers["claude-code"] = ["opus", "new-1"];
    await refreshed(harness);
    const status = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
    expect(status.overBudget.map((r: { model: string; role: string; project: string }) => [r.model, r.role, r.project])).toEqual([
      ["new-1", "top-level", "bb-plugins"],
      ["new-1", "top-level", ""],
      ["new-1", "child", "bb-plugins"],
      ["new-1", "child", ""],
    ]);
    expect(status.overBudget[0].since).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    const logged = warnings(harness).filter((line) => line.startsWith("over budget"));
    expect(logged).toHaveLength(4);
    expect(logged[0]).toBe(
      'over budget: claude-code new-1 top-level project "bb-plugins": 6002; the rules would be cut at runtime',
    );
    const text = (await harness.runCli(["status"])).stdout;
    expect(text).toContain(`claude-code new-1 top-level project "bb-plugins": 6002 (over budget since ${status.overBudget[0].since})`);

    // The same overflow on the next refresh is neither logged again nor given a new time.
    await refreshed(harness);
    expect(warnings(harness).filter((line) => line.startsWith("over budget"))).toHaveLength(4);
    expect(JSON.parse((await harness.runCli(["status", "--json"])).stdout).overBudget[0].since).toBe(status.overBudget[0].since);

    // Once the model is gone the record is cleared.
    world.providers["claude-code"] = ["opus"];
    await refreshed(harness);
    expect(JSON.parse((await harness.runCli(["status", "--json"])).stdout).overBudget).toEqual([]);
  });

  it("records nothing for a refresh without an overflow", async () => {
    const { harness, world } = await load({ settings: { rules: NEW_MODEL_ONLY } });
    world.providers["claude-code"] = ["opus", "newer-thing"];
    world.providers.codex = ["gpt"];
    await refreshed(harness);
    expect(JSON.parse((await harness.runCli(["status", "--json"])).stdout).overBudget).toEqual([]);
    expect(warnings(harness).filter((line) => line.startsWith("over budget"))).toEqual([]);
  });

  it("keeps the records while a list cannot be trusted", async () => {
    const { harness } = await load({
      settings: { rules: rules({ instructions: x(3000) }, { instructions: x(3000) }) },
      sdk: {},
    });
    const before = JSON.parse((await harness.runCli(["status", "--json"])).stdout).overBudget;
    expect(before).not.toEqual([]);
    harness.sdk.stub("projects.list", async () => {
      throw new Error("down");
    });
    await refreshed(harness);
    expect(JSON.parse((await harness.runCli(["status", "--json"])).stdout).overBudget).toEqual(before);
  });
});

describe("the project and provider caches", () => {
  it("refreshes through the background loop until the signal aborts", async () => {
    const { harness } = await load();
    const before = harness.sdk.callsTo("projects.list").length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { controller, done } = harness.runService("project-path-cache");
    await vi.advanceTimersByTimeAsync(60_000);
    const afterLoop = harness.sdk.callsTo("projects.list").length;
    expect(afterLoop).toBeGreaterThan(before);
    expect(harness.sdk.callsTo("providers.list").length).toBeGreaterThan(1);
    controller.abort();
    await done;
    expect(harness.sdk.callsTo("projects.list").length).toBe(afterLoop);
  });

  it("stops waiting as soon as the signal aborts", async () => {
    const { harness } = await load();
    const before = harness.sdk.callsTo("projects.list").length;
    const { controller, done } = harness.runService("project-path-cache");
    controller.abort();
    await done;
    expect(harness.sdk.callsTo("projects.list").length).toBe(before);
  });

  it("refreshes the cache when a thread is created, so a new project's checkouts count", async () => {
    const root = path.join(base, "repos");
    mkdirSync(path.join(root, "new"), { recursive: true });
    const { harness, world } = await load({
      settings: { rules: JSON.stringify({ scopes: [{ name: "r", paths: [root] }], rules: [{ scope: "r", instructions: "scoped" }] }) },
    });
    expect((await configure(harness, { project: { id: "proj_new" }, path: null })).instructions).toBeNull();
    world.projects = [{ id: "proj_new", name: "new", sources: [{ path: path.join(root, "new"), hostId: "h" }] }];
    const before = harness.sdk.callsTo("projects.list").length;
    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_created" }) });
    await vi.waitFor(() => expect(harness.sdk.callsTo("projects.list").length).toBeGreaterThan(before));
    await vi.waitFor(async () =>
      expect((await configure(harness, { project: { id: "proj_new" }, path: null })).instructions).toBe("scoped"),
    );
  });

  it("ignores checkouts without a path, and projects without sources", async () => {
    const root = path.join(base, "repos");
    mkdirSync(root, { recursive: true });
    const world = DEFAULT_WORLD();
    world.projects = [
      { id: "proj_none", name: "none" },
      { id: "proj_empty", name: "empty", sources: [{ path: "" }, {}] },
    ];
    const { harness } = await load({
      world,
      settings: { rules: JSON.stringify({ scopes: [{ name: "r", paths: [root] }], rules: [{ scope: "r", instructions: "x" }] }) },
    });
    expect((await configure(harness, { project: { id: "proj_none" }, path: null })).instructions).toBeNull();
    expect((await configure(harness, { project: { id: "proj_empty" }, path: null })).instructions).toBeNull();
  });

  it.each([
    ["an Error", new Error("boom-secret"), "boom-secret"],
    ["a string", "boom-string", "boom-string"],
  ])("warns with the message when a refresh fails with %s", async (_label, failure, text) => {
    const { harness } = await load({
      sdk: {
        projects: { list: async () => { throw failure; } },
        providers: { list: async () => { throw failure; }, models: async () => ({}) },
      },
    });
    expect(warnings(harness)).toContain(`project list refresh failed: ${text}`);
    expect(warnings(harness)).toContain(`provider list refresh failed: ${text}`);
  });

  it("skips providers that are not available and does not ask them for models", async () => {
    const models = vi.fn(async () => ({ models: [{ id: "m", model: "m" }], modelLoadError: null }));
    const { harness } = await load({
      settings: { rules: rules({ instructions: x(5000) }).replace("5000", "5000") },
      sdk: {
        providers: {
          list: async () => [
            { id: "ready", available: true },
            { id: "missing", available: false },
          ],
          models,
        },
      },
    });
    expect(models).toHaveBeenCalledTimes(1);
    expect(models).toHaveBeenCalledWith(expect.objectContaining({ providerId: "ready" }));
    const all = JSON.parse((await harness.runCli(["check", "--all", "--json"])).stdout);
    expect(all.checked).toBe(2 * 2);
  });

  it("de-duplicates a provider's models and passes an abort signal", async () => {
    const list = vi.fn(async (_args: { signal: AbortSignal }) => [{ id: "p", available: true }]);
    const { harness } = await load({
      sdk: {
        providers: {
          list,
          models: async () => ({
            models: [{ id: "m", model: "m" }, { id: "m-alias", model: "m" }, { id: "n", model: "n" }],
            modelLoadError: null,
          }),
        },
      },
    });
    expect(list.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    const all = JSON.parse((await harness.runCli(["check", "--all", "--json"])).stdout);
    expect(all.checked).toBe(2 * 2 * 2);
  });

  it("treats a provider whose models failed to load as a failed refresh", async () => {
    const { harness } = await load({
      sdk: {
        providers: {
          list: async () => [{ id: "p", available: true }],
          models: async () => ({ models: [], modelLoadError: { code: "auth_required", detail: null, providerId: "p" } }),
        },
      },
    });
    expect(warnings(harness)).toContain("provider list refresh failed: p: models not loaded (auth_required)");
    await expect(harness.setSettings({ rules: rules({ instructions: "x" }) })).rejects.toThrow(
      "budget not checkable yet: provider list not loaded; retry",
    );
  });
});

describe("bb model-instructions status", () => {
  const SETTING = JSON.stringify({
    scopes: [{ name: "work", paths: ["/work/one", "/work/two"] }],
    rules: [
      { name: "gchat", provider: "claude-code", scope: "work", threads: "top-level", instructions: "g".repeat(12) },
      { skills: ["work-*"], project: ["a", "b"], skipProjects: "c", skipTitles: "T*", model: "m*" },
      { instructions: "all" },
    ],
  });

  it("lists scopes, rules, claimed and unclaimed skills and the cache state as JSON", async () => {
    const { harness } = await load({ settings: { rules: SETTING } });
    const result = await harness.runCli(["status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      scopes: [{ name: "work", paths: ["/work/one", "/work/two"] }],
      rules: [
        {
          name: "gchat",
          matchers: { provider: "claude-code", scope: ["work"], threads: "top-level" },
          instructionsLength: 12,
          skills: [],
        },
        {
          name: "rules[1]",
          matchers: { model: "m*", project: ["a", "b"], skipProjects: ["c"], skipTitles: ["T*"] },
          instructionsLength: null,
          skills: ["work-*"],
        },
        { name: "rules[2]", matchers: {}, instructionsLength: 3, skills: [] },
      ],
      skills: [
        { name: "model-instructions", claimedBy: null },
        { name: "other", claimedBy: [] },
        { name: "work-conventions", claimedBy: ["rules[1]"] },
      ],
      unclaimedSkills: ["other"],
      cache: {
        providers: { loaded: true, failed: false },
        projects: { loaded: true, failed: false },
      },
      overBudget: [],
      overflowEvents: [],
    });
  });

  it("prints the same as text, and is the default command", async () => {
    const { harness } = await load({ settings: { rules: SETTING } });
    const text = (await harness.runCli([])).stdout;
    expect(text).toBe(
      [
        "scopes:",
        "  work: /work/one, /work/two",
        "",
        "rules:",
        "  gchat  provider=claude-code scope=work threads=top-level  instructions=12 chars",
        "  rules[1]  model=m* project=a|b skipProjects=c skipTitles=T*  no instructions  skills=work-*",
        "  rules[2]  (matches every thread)  instructions=3 chars",
        "",
        "skills:",
        "  model-instructions  always injected",
        "  other  claimed by no rule",
        "  work-conventions  claimed by rules[1]",
        "unclaimed skills (injected nowhere): other",
        "",
        "cache: provider list loaded; project list loaded",
        "",
        "over budget:",
        "  (none)",
        "",
        "recent overflow events:",
        "  (none)",
        "",
      ].join("\n"),
    );
  });

  it("prints the empty state and every skill claimed", async () => {
    const { harness } = await load({ skills: [] });
    const text = (await harness.runCli(["status"])).stdout;
    expect(text).toContain("scopes:\n  (none)");
    expect(text).toContain("rules:\n  (none)");
    expect(text).toContain("unclaimed skills: none");
    expect(text).toContain("  model-instructions  always injected");
  });

  it("shows lists that never loaded", async () => {
    const { harness } = await load({
      sdk: {
        providers: { list: async () => { throw new Error("down"); }, models: async () => ({}) },
        projects: { list: async () => { throw new Error("down"); } },
      },
    });
    expect((await harness.runCli(["status"])).stdout).toContain(
      "cache: provider list not loaded, last refresh failed; project list not loaded, last refresh failed",
    );
  });

  it("shows a list that loaded once and failed since, and one not loaded yet without a failure", async () => {
    const { harness } = await load();
    harness.sdk.stub("projects.list", async () => {
      throw new Error("down");
    });
    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "t" }) });
    await vi.waitFor(async () =>
      expect((await harness.runCli(["status"])).stdout).toContain(
        "cache: provider list loaded; project list loaded, last refresh failed",
      ),
    );
  });

  it("rejects an extra argument", async () => {
    const { harness } = await load();
    const result = await harness.runCli(["status", "--bogus"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('status: unknown argument "--bogus"');
    expect(result.stderr).toContain("usage: bb model-instructions status [--json]");
  });
});

describe("bb model-instructions check", () => {
  const SETTING = JSON.stringify({
    scopes: [{ name: "work", paths: ["/work"] }],
    rules: [
      { name: "guard", instructions: "Guard." },
      { name: "opus-only", model: "opus*", instructions: "Opus text." },
      { name: "child-only", threads: "child", instructions: "Child text." },
      { name: "work-only", scope: "work", skills: "work-*", instructions: "Work text." },
      { name: "titled", skipTitles: "Helpdesk*", instructions: "Titled." },
    ],
  });

  async function loadForCheck(thread: Record<string, unknown> | null = {}) {
    const world = DEFAULT_WORLD();
    world.projects = [
      { id: "proj_1", name: "bb-plugins", sources: [{ path: "/work/app", hostId: "h" }] },
      { id: "proj_2", name: "other", sources: [{ path: "/elsewhere", hostId: "h" }] },
    ];
    const lookup = {
      get: vi.fn(async () => {
        if (thread === null) throw new Error("no thread");
        return {
          providerId: "claude-code",
          parentThreadId: null,
          projectId: "proj_1",
          title: "Fix the bug",
          environment: { path: "/work/app" },
          ...thread,
        };
      }),
      defaultExecutionOptions: vi.fn(async () => ({ model: "opus" })),
    };
    const loaded = await load({
      world,
      settings: { rules: SETTING },
      sdk: { threads: lookup },
    });
    return { ...loaded, lookup };
  }

  const ctx = { threadId: "thr_cli", projectId: "proj_1", cwd: "/cwd" };

  it("defaults provider, model, role, project, path and title from the thread and says so", async () => {
    const { harness, lookup } = await loadForCheck();
    const result = await harness.runCli(["check", "--json"], ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      target: {
        provider: "claude-code",
        model: "opus",
        role: "top-level",
        project: "bb-plugins",
        projectId: "proj_1",
        path: "/work/app",
        title: "Fix the bug",
      },
      sources: { provider: "thread", model: "thread", role: "thread", title: "thread", project: "context", path: "thread" },
      matched: ["guard", "opus-only", "work-only", "titled"],
      fullLength: 6 + 2 + 10 + 2 + 10 + 2 + 7,
      length: 6 + 2 + 10 + 2 + 10 + 2 + 7,
      limit: 4096,
      dropped: [],
      skills: ["model-instructions", "work-conventions"],
    });
    expect(lookup.get).toHaveBeenCalledWith({ threadId: "thr_cli", include: "environment" });
  });

  it("prints the defaults in text", async () => {
    const { harness } = await loadForCheck();
    expect((await harness.runCli(["check"], ctx)).stdout).toBe(
      [
        "provider: claude-code (thread)",
        "model: opus (thread)",
        "role: top-level (thread)",
        'project: bb-plugins [proj_1] (context)',
        "path: /work/app (thread)",
        'title: "Fix the bug" (thread)',
        "",
        "matched rules: guard, opus-only, work-only, titled",
        "length: 39/4096",
        "dropped: none",
        "skills: model-instructions, work-conventions",
        "",
      ].join("\n"),
    );
  });

  it("lets explicit flags override every default", async () => {
    const { harness } = await loadForCheck();
    const result = JSON.parse(
      (
        await harness.runCli(
          ["check", "--provider", "codex", "--model", "gpt", "--child", "--project", "proj_2", "--path", "/work/x", "--title", "Helpdesk: A", "--json"],
          ctx,
        )
      ).stdout,
    );
    expect(result.target).toEqual({
      provider: "codex",
      model: "gpt",
      role: "child",
      project: "other",
      projectId: "proj_2",
      path: "/work/x",
      title: "Helpdesk: A",
    });
    expect(result.sources).toEqual({ provider: "flag", model: "flag", role: "flag", title: "flag", project: "flag", path: "flag" });
    expect(result.matched).toEqual(["guard", "child-only", "work-only"]);
  });

  it("looks the project name up from the id and uses its checkouts for scopes", async () => {
    const { harness } = await loadForCheck();
    const inScope = JSON.parse((await harness.runCli(["check", "--project", "proj_1", "--provider", "p", "--model", "m", "--json"], ctx)).stdout);
    expect(inScope.target.project).toBe("bb-plugins");
    expect(inScope.target.path).toBeNull();
    expect(inScope.sources.path).toBe("assumed");
    expect(inScope.matched).toContain("work-only");
    const outside = JSON.parse((await harness.runCli(["check", "--project", "proj_2", "--provider", "p", "--model", "m", "--json"], ctx)).stdout);
    expect(outside.matched).not.toContain("work-only");
  });

  it("keeps the thread's role, and reports a child thread", async () => {
    const { harness } = await loadForCheck({ parentThreadId: "thr_parent" });
    const result = JSON.parse((await harness.runCli(["check", "--json"], ctx)).stdout);
    expect(result.target.role).toBe("child");
    expect(result.sources.role).toBe("thread");
    expect(result.matched).toContain("child-only");
  });

  it("applies the thread's title to skipTitles", async () => {
    const { harness } = await loadForCheck({ title: "Helpdesk: Anna" });
    expect(JSON.parse((await harness.runCli(["check", "--json"], ctx)).stdout).matched).not.toContain("titled");
  });

  it("falls back to the context's project and path when the thread says nothing", async () => {
    const { harness } = await loadForCheck({ environment: null, title: null });
    const result = JSON.parse((await harness.runCli(["check", "--json"], { ...ctx, cwd: "/work/cwd" })).stdout);
    expect(result.target.path).toBe("/work/cwd");
    expect(result.sources.path).toBe("context");
    expect(result.target.title).toBeNull();
    const noCwd = JSON.parse((await harness.runCli(["check", "--json"], { threadId: "thr_cli", projectId: "proj_1" })).stdout);
    expect(noCwd.target.path).toBeNull();
    expect(noCwd.sources.path).toBe("assumed");
    const text = (await harness.runCli(["check"], { threadId: "thr_cli", projectId: "proj_1" })).stdout;
    expect(text).toContain("path: (none) (assumed)");
    expect(text).toContain("title: (none) (thread)");
  });

  it("takes the project from the thread when the context has none", async () => {
    const { harness } = await loadForCheck();
    const result = JSON.parse((await harness.runCli(["check", "--json"], { threadId: "thr_cli" })).stdout);
    expect(result.target.projectId).toBe("proj_1");
    expect(result.sources.project).toBe("thread");
  });

  it("works without a thread when provider and model are given, assuming a top-level thread and no project", async () => {
    const { harness, lookup } = await loadForCheck();
    const result = JSON.parse(
      (await harness.runCli(["check", "--provider", "codex", "--model", "gpt", "--json"], {})).stdout,
    );
    expect(lookup.get).not.toHaveBeenCalled();
    expect(result.target).toEqual({ provider: "codex", model: "gpt", role: "top-level", project: "", projectId: null, path: null, title: null });
    expect(result.sources).toMatchObject({ role: "assumed", project: "assumed", title: "assumed", path: "assumed" });
    const text = (await harness.runCli(["check", "--provider", "codex", "--model", "gpt"], {})).stdout;
    expect(text).toContain("project: (none) (assumed)");
  });

  it("reports an empty result when no rule matches", async () => {
    const { harness } = await load({ settings: { rules: rules({ provider: "codex", instructions: "x" }) } });
    const json = JSON.parse((await harness.runCli(["check", "--provider", "claude-code", "--model", "m", "--json"], {})).stdout);
    expect(json).toMatchObject({ matched: [], length: 0, fullLength: 0, dropped: [], skills: ["model-instructions"] });
    const text = (await harness.runCli(["check", "--provider", "claude-code", "--model", "m"], {})).stdout;
    expect(text).toContain("matched rules: none\nlength: 0/4096\ndropped: none");
  });

  it("works when the thread lookup fails, with flags", async () => {
    const { harness } = await loadForCheck(null);
    const ok = await harness.runCli(["check", "--provider", "codex", "--model", "gpt", "--json"], ctx);
    expect(ok.exitCode).toBe(0);
    const missing = await harness.runCli(["check"], ctx);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("check: --provider is needed; no thread to default it from");
  });

  it("needs a model when only the provider is known", async () => {
    const { harness } = await loadForCheck();
    const result = await harness.runCli(["check", "--provider", "codex"], {});
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("check: --model is needed");
  });

  it("rejects a project id that is not in the cache", async () => {
    const { harness } = await loadForCheck();
    const result = await harness.runCli(["check", "--project", "proj_gone", "--provider", "p", "--model", "m"], ctx);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("check: project proj_gone is not in the project cache; check the id or retry\n");
  });

  it("reports a dropped rule and the length with the notice", async () => {
    const { harness } = await load({
      settings: { rules: rules({ name: "g", instructions: x(3000) }, { name: "e", instructions: x(1500) }) },
      sdk: { threads: { get: async () => ({ providerId: "claude-code", parentThreadId: null, projectId: "proj_1", title: null }), defaultExecutionOptions: async () => null } },
    });
    const result = JSON.parse((await harness.runCli(["check", "--model", "opus", "--json"], ctx)).stdout);
    expect(result.dropped).toEqual(["e"]);
    expect(result.fullLength).toBe(4502);
    expect(result.length).toBe(3000 + 2 + omittedNotice(1).length);
    const text = (await harness.runCli(["check", "--model", "opus"], ctx)).stdout;
    expect(text).toContain("dropped: e");
    expect(text).toContain(`length: ${result.length}/4096`);
  });

  it("shows no model default when the thread has no execution options", async () => {
    const { harness } = await load({
      sdk: { threads: { get: async () => ({ providerId: "claude-code", parentThreadId: null, projectId: "proj_1", title: null }), defaultExecutionOptions: async () => null } },
    });
    const result = await harness.runCli(["check"], ctx);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--model is needed");
  });

  it.each([
    [["check", "--bogus"], 'check: unknown argument "--bogus"'],
    [["check", "--model"], "check: --model needs a value"],
    [["check", "--all", "--model", "m"], "check: --all takes no other flag except --json"],
    [["check", "--all", "--child"], "check: --all takes no other flag except --json"],
  ])("rejects %j", async (argv, message) => {
    const { harness } = await loadForCheck();
    const result = await harness.runCli(argv, ctx);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("usage: bb model-instructions status [--json] | check");
  });

  it("rejects an unknown command with a usage hint", async () => {
    const { harness } = await loadForCheck();
    const result = await harness.runCli(["bogus"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(
      'unknown command "bogus"\nusage: bb model-instructions status [--json] | check [--provider P] [--model M] [--child] [--project <id>] [--path <dir>] [--title T] [--json] | check --all [--json]\n',
    );
  });
});

describe("bb model-instructions check --all", () => {
  it("prints the save-time table grouped like the budget error", async () => {
    const world = DEFAULT_WORLD();
    world.providers = { "claude-code": ["opus"], codex: ["a", "b", "c"] };
    const { harness } = await load({
      world,
      settings: { rules: rules({ name: "a", instructions: x(3000) }, { name: "b", instructions: x(3000) }) },
    });
    const result = await harness.runCli(["check", "--all"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(
      [
        "over the 4096-character limit with a, b:",
        '  claude-code opus top-level project "bb-plugins": 6002',
        "  claude-code opus top-level project (none): 6002",
        '  claude-code opus child project "bb-plugins": 6002',
        "  claude-code opus child project (none): 6002",
        '  codex a top-level project "bb-plugins": 6002',
        "  and 11 more",
        "16 of 16 thread types are over the limit",
        "",
      ].join("\n"),
    );
    const json = JSON.parse((await harness.runCli(["check", "--all", "--json"])).stdout);
    expect(json).toMatchObject({ ok: false, limit: 4096, checked: 16, overflowing: 16 });
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0]).toMatchObject({ rules: ["a", "b"], more: 11 });
    expect(json.groups[0].shown).toHaveLength(5);
  });

  it("succeeds when nothing is over the limit", async () => {
    const { harness } = await load({ settings: { rules: rules({ instructions: "small" }) } });
    const text = await harness.runCli(["check", "--all"]);
    expect(text).toMatchObject({ exitCode: 0, stdout: "no thread type exceeds 4096 characters (4 checked)\n" });
    const json = JSON.parse((await harness.runCli(["check", "--all", "--json"])).stdout);
    expect(json).toMatchObject({ ok: true, checked: 4, overflowing: 0, groups: [] });
  });

  it("refuses while a list is not loaded", async () => {
    const { harness } = await load({
      sdk: { projects: { list: async () => { throw new Error("down"); } } },
    });
    const text = await harness.runCli(["check", "--all"]);
    expect(text).toMatchObject({ exitCode: 1, stderr: "budget not checkable yet: project list not loaded; retry\n" });
    const json = await harness.runCli(["check", "--all", "--json"]);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ ok: false, error: "budget not checkable yet: project list not loaded; retry" });
  });
});

describe("registration", () => {
  it("registers the model-instructions command with status and check", async () => {
    const { harness } = await load();
    expect(harness.registrations.cli?.name).toBe("model-instructions");
    expect(harness.registrations.cli?.commands?.map((command) => command.name)).toEqual(["status", "check"]);
  });

  it("describes the setting briefly and points to the README, status and check", async () => {
    const { harness } = await load();
    const rulesSetting = harness.registrations.settingsDescriptors.rules as { description?: string; default?: string };
    expect(rulesSetting.default).toBe("[]");
    expect(rulesSetting.description).toContain("JSON array of rules");
    expect(rulesSetting.description).toContain('{ "vars"?, "scopes"?, "rules" }');
    expect(rulesSetting.description).toContain("README");
    expect(rulesSetting.description).toContain("bb model-instructions status");
    expect(rulesSetting.description).toContain("bb model-instructions check");
    expect(rulesSetting.description!.length).toBeLessThan(300);
  });
});
