import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  vi.doUnmock("./src/budget.js");
  vi.restoreAllMocks();
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

/** The first cache refresh is not awaited at startup; let its promise chain run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
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
  await flushMicrotasks();
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
      "budget not checkable yet: provider list refresh failed; retry after the next refresh (every minute), or see bb model-instructions status",
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
        "budget not checkable yet: project list refresh failed; retry after the next refresh (every minute), or see bb model-instructions status",
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
        "project list refresh failed",
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

  it("updates the length and rules of a record that is still over budget, and keeps its time", async () => {
    const root = path.join(base, "scoped");
    mkdirSync(path.join(root, "checkout"), { recursive: true });
    const { harness, world } = await load({
      settings: {
        rules: JSON.stringify({
          scopes: [{ name: "r", paths: [root] }],
          rules: [
            { name: "a", model: "new-*", instructions: x(3000) },
            { name: "b", model: "new-*", instructions: x(3000) },
            { name: "c", model: "new-*", scope: "r", instructions: x(500) },
          ],
        }),
      },
    });
    world.providers["claude-code"] = ["opus", "new-1"];
    await refreshed(harness);
    const record = async () =>
      JSON.parse((await harness.runCli(["status", "--json"])).stdout).overBudget.find(
        (entry: { model: string; role: string; project: string }) =>
          entry.model === "new-1" && entry.role === "top-level" && entry.project === "bb-plugins",
      );
    const first = await record();
    expect(first).toMatchObject({ length: 6002, rules: [0, 1] });
    // The project gains a checkout inside the scope: rule c now matches too.
    world.projects = [{ id: "proj_1", name: "bb-plugins", sources: [{ path: path.join(root, "checkout"), hostId: "h" }] }];
    await refreshed(harness);
    const second = await record();
    expect(second).toMatchObject({ length: 6504, rules: [0, 1, 2], since: first.since });
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

  describe("a provider whose models cannot be listed", () => {
    const MIXED = {
      providers: {
        list: async () => [
          { id: "good", available: true },
          { id: "needs-auth", available: true },
          { id: "broken", available: true },
        ],
        models: async ({ providerId }: { providerId: string }) => {
          if (providerId === "broken") throw new Error("socket closed");
          if (providerId === "needs-auth")
            return { models: [], modelLoadError: { code: "auth_required", detail: null, providerId } };
          return { models: [{ id: "m", model: "m" }], modelLoadError: null };
        },
      },
    };

    it("is left out and recorded as unchecked; the others are still checked and the save is accepted", async () => {
      const { harness } = await load({ sdk: MIXED });
      expect(warnings(harness)).toContain("provider needs-auth left unchecked: models not loaded (auth_required)");
      expect(warnings(harness)).toContain("provider broken left unchecked: models not loaded (socket closed)");
      await harness.setSettings({ rules: rules({ instructions: "fits" }) });
      expect((await configure(harness, { provider: "good", model: "m" })).instructions).toBe("fits");
      // The provider that loaded is still budget-checked.
      await expect(
        harness.setSettings({ rules: rules({ instructions: x(2500) }, { instructions: x(2500) }) }),
      ).rejects.toThrow("good m top-level");
    });

    it("is listed with its reason by status, in text and in JSON", async () => {
      const { harness } = await load({ sdk: MIXED });
      const unchecked = [
        { id: "needs-auth", reason: "auth_required" },
        { id: "broken", reason: "socket closed" },
      ];
      const json = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
      expect(json.cache.providers).toEqual({ loaded: true, failed: false, unchecked });
      expect((await harness.runCli(["status"])).stdout).toContain(
        "unchecked providers: needs-auth (auth_required), broken (socket closed)",
      );
    });

    it("is listed by check --all, in text and in JSON", async () => {
      const { harness } = await load({ sdk: MIXED });
      const text = await harness.runCli(["check", "--all"]);
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toBe(
        "no thread type exceeds 4096 characters (4 checked)\nunchecked providers: needs-auth (auth_required), broken (socket closed)\n",
      );
      const json = JSON.parse((await harness.runCli(["check", "--all", "--json"])).stdout);
      expect(json.uncheckedProviders).toEqual([
        { id: "needs-auth", reason: "auth_required" },
        { id: "broken", reason: "socket closed" },
      ]);
    });

    it("lists the unchecked providers after an overflow table too", async () => {
      const { harness } = await load({
        sdk: MIXED,
        settings: { rules: rules({ instructions: x(3000) }, { instructions: x(3000) }) },
      });
      const text = await harness.runCli(["check", "--all"]);
      expect(text.exitCode).toBe(1);
      expect(text.stdout.trimEnd().split("\n").pop()).toBe(
        "unchecked providers: needs-auth (auth_required), broken (socket closed)",
      );
    });

    it("is checked again once it comes back, and an overflow is recorded then", async () => {
      const models: Record<string, string[] | null> = { good: ["m"], late: null };
      const { harness } = await load({
        settings: { rules: rules({ model: "late-*", instructions: x(3000) }, { model: "late-*", instructions: x(3000) }) },
        sdk: {
          providers: {
            list: async () => [{ id: "good", available: true }, { id: "late", available: true }],
            models: async ({ providerId }: { providerId: string }) => {
              const found = models[providerId];
              if (found === null) throw new Error("not yet");
              return { models: found.map((model) => ({ id: model, model })), modelLoadError: null };
            },
          },
        },
      });
      expect(JSON.parse((await harness.runCli(["status", "--json"])).stdout).overBudget).toEqual([]);
      models.late = ["late-1"];
      const before = harness.sdk.callsTo("providers.list").length;
      await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "t" }) });
      await vi.waitFor(async () => {
        const status = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
        expect(harness.sdk.callsTo("providers.list").length).toBeGreaterThan(before);
        expect(status.cache.providers.unchecked).toEqual([]);
        expect(status.overBudget.map((record: { model: string }) => record.model)).toContain("late-1");
      });
    });

    it("does not make the provider list failed; a failing providers.list does", async () => {
      const { harness } = await load({ sdk: MIXED });
      expect((await harness.runCli(["status"])).stdout).toContain("cache: provider list loaded;");
      const failing = await load({
        sdk: { providers: { list: async () => { throw new Error("down"); }, models: async () => ({}) } },
      });
      await expect(failing.harness.setSettings({ rules: rules({ instructions: "x" }) })).rejects.toThrow(
        "budget not checkable yet: provider list refresh failed; retry after the next refresh (every minute), or see bb model-instructions status",
      );
    });
  });
});

describe("a provider whose model lookup hangs", () => {
  it("gives every models call its own timeout, so one hung provider does not leave the later ones unchecked", async () => {
    const controllers: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    const signals: Record<string, AbortSignal> = {};
    const { harness } = await load({
      sdk: {
        providers: {
          list: async () => ["hung", "later-a", "later-b"].map((id) => ({ id, available: true })),
          models: ({ providerId, signal }: { providerId: string; signal: AbortSignal }) => {
            signals[providerId] = signal;
            if (providerId !== "hung")
              return Promise.resolve({ models: [{ id: "m", model: "m" }], modelLoadError: null });
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")), { once: true });
            });
          },
        },
      },
    });
    // All lookups started at once; the hung provider's own timeout fires.
    expect(Object.keys(signals).sort()).toEqual(["hung", "later-a", "later-b"]);
    controllers.find((controller) => controller.signal === signals.hung)!.abort();
    await vi.waitFor(async () => {
      const status = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
      expect(status.cache.providers.unchecked).toEqual([{ id: "hung", reason: "timed out" }]);
    });
    // Both later providers were checked: 2 providers × 1 model × 2 roles × (1 project + none).
    expect(JSON.parse((await harness.runCli(["check", "--all", "--json"])).stdout).checked).toBe(8);
    expect(signals["later-a"]).not.toBe(signals.hung);
    expect(signals["later-b"]).not.toBe(signals["later-a"]);
    expect(signals["later-a"].aborted).toBe(false);
    expect(signals["later-b"].aborted).toBe(false);
  });
});

describe("model lookups", () => {
  it("start for every available provider before any resolves, and the result keeps the provider list order", async () => {
    const started: string[] = [];
    const resolvers: Record<string, () => void> = {};
    const { harness } = await load({
      settings: { rules: rules({ instructions: x(3000) }, { instructions: x(3000) }) },
      sdk: {
        providers: {
          list: async () => ["first", "off", "second"].map((id) => ({ id, available: id !== "off" })),
          models: ({ providerId }: { providerId: string }) => {
            started.push(providerId);
            return new Promise((resolve) => {
              resolvers[providerId] = () =>
                resolve({ models: [{ id: `${providerId}-m`, model: `${providerId}-m` }], modelLoadError: null });
            });
          },
        },
      },
    });
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    // Resolve in reverse order: the list still follows the provider list.
    resolvers.second();
    resolvers.first();
    await vi.waitFor(async () => {
      const status = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
      expect(status.cache.providers.loaded).toBe(true);
    });
    const json = JSON.parse((await harness.runCli(["check", "--all", "--json"])).stdout);
    expect(json.checked).toBe(2 * 2 * 2);
    const status = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
    const order = status.overBudget.map((record: { provider: string }) => record.provider);
    expect(order.indexOf("first")).toBeGreaterThanOrEqual(0);
    expect(order.lastIndexOf("first")).toBeLessThan(order.indexOf("second"));
  });

  it("list the unchecked providers in the provider list order too", async () => {
    const { harness } = await load({
      sdk: {
        providers: {
          list: async () => ["a", "b", "c"].map((id) => ({ id, available: true })),
          models: ({ providerId }: { providerId: string }) =>
            providerId === "a"
              ? new Promise((_resolve, reject) => setTimeout(() => reject(new Error("slow failure")), 20))
              : Promise.reject(new Error(`${providerId} failed`)),
        },
      },
    });
    await vi.waitFor(async () => {
      const status = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
      expect(status.cache.providers.unchecked).toEqual([
        { id: "a", reason: "slow failure" },
        { id: "b", reason: "b failed" },
        { id: "c", reason: "c failed" },
      ]);
    });
  });
});

describe("a provider that lists no models", () => {
  const EMPTY = { models: [], modelLoadError: null };

  it("is unchecked, and a save is rejected when it is the only available provider", async () => {
    const { harness } = await load({
      sdk: { providers: { list: async () => [{ id: "empty", available: true }], models: async () => EMPTY } },
    });
    await expect(harness.setSettings({ rules: rules({ instructions: "x" }) })).rejects.toThrow(
      "budget not checkable yet: no provider's models could be listed (empty (no models listed)); see bb model-instructions status",
    );
  });

  it("is listed as unchecked while another provider's models are still checked", async () => {
    const { harness } = await load({
      sdk: {
        providers: {
          list: async () => [{ id: "empty", available: true }, { id: "good", available: true }],
          models: async ({ providerId }: { providerId: string }) =>
            providerId === "empty" ? EMPTY : { models: [{ id: "m", model: "m" }], modelLoadError: null },
        },
      },
    });
    await harness.setSettings({ rules: rules({ instructions: "fits" }) });
    const json = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
    expect(json.cache.providers.unchecked).toEqual([{ id: "empty", reason: "no models listed" }]);
    expect((await harness.runCli(["status"])).stdout).toContain("unchecked providers: empty (no models listed)");
    expect(warnings(harness)).toContain("provider empty left unchecked: models not loaded (no models listed)");
  });
});

describe("a save while no provider's models could be listed", () => {
  const ALL_UNCHECKED = {
    providers: {
      list: async () => [{ id: "needs-auth", available: true }, { id: "broken", available: true }],
      models: async ({ providerId }: { providerId: string }) => {
        if (providerId === "broken") throw new Error("socket closed");
        return { models: [], modelLoadError: { code: "auth_required", detail: null, providerId } };
      },
    },
  };

  it("rejects a value with text, and check --all refuses with the same message", async () => {
    const { harness } = await load({ sdk: ALL_UNCHECKED });
    const message =
      "budget not checkable yet: no provider's models could be listed (needs-auth (auth_required), broken (socket closed)); see bb model-instructions status";
    await expect(harness.setSettings({ rules: rules({ instructions: "x" }) })).rejects.toThrow(message);
    expect(await harness.runCli(["check", "--all"])).toMatchObject({ exitCode: 1, stderr: `${message}\n` });
    // No instruction text: nothing to check, so the save is accepted.
    await harness.setSettings({ rules: rules({ skills: "other" }) });
  });

  it("accepts a value once one provider could be listed", async () => {
    let authed = false;
    const { harness } = await load({
      sdk: {
        providers: {
          list: async () => [{ id: "p", available: true }],
          models: async ({ providerId }: { providerId: string }) =>
            authed
              ? { models: [{ id: "m", model: "m" }], modelLoadError: null }
              : { models: [], modelLoadError: { code: "auth_required", detail: null, providerId } },
        },
      },
    });
    await expect(harness.setSettings({ rules: rules({ instructions: "x" }) })).rejects.toThrow("no provider's models could be listed (p (auth_required))");
    authed = true;
    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "t" }) });
    await vi.waitFor(async () => {
      await harness.setSettings({ rules: rules({ instructions: "x" }) });
    });
  });

  it("accepts a value when no provider is available at all", async () => {
    const { harness } = await load({
      sdk: { providers: { list: async () => [{ id: "off", available: false }], models: async () => ({}) } },
    });
    await harness.setSettings({ rules: rules({ instructions: "x" }) });
    expect((await configure(harness)).instructions).toBe("x");
  });

  it("says the list was not loaded while the first refresh has not finished", async () => {
    const { harness } = await load({
      sdk: { providers: { list: () => new Promise(() => {}), models: async () => ({}) } },
    });
    await expect(harness.setSettings({ rules: rules({ instructions: "x" }) })).rejects.toThrow(
      "budget not checkable yet: provider list not loaded; retry after the next refresh (every minute), or see bb model-instructions status",
    );
  });
});

describe("a project list lookup that is aborted", () => {
  it("counts as failed, keeps the last good data, and recovers on the next refresh", async () => {
    const root = path.join(base, "repos");
    mkdirSync(path.join(root, "app"), { recursive: true });
    const world = DEFAULT_WORLD();
    world.projects = [{ id: "proj_1", name: "bb-plugins", sources: [{ path: path.join(root, "app"), hostId: "h" }] }];
    let aborted = false;
    const list = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted();
      return world.projects;
    });
    const { harness } = await load({
      world,
      sdk: { projects: { list } },
      settings: { rules: JSON.stringify({ scopes: [{ name: "r", paths: [root] }], rules: [{ scope: "r", instructions: "scoped" }] }) },
    });
    expect((await configure(harness, { path: null })).instructions).toBe("scoped");
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => (aborted ? AbortSignal.abort() : realTimeout(ms)));
    aborted = true;
    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "t1" }) });
    await vi.waitFor(async () =>
      expect((await harness.runCli(["status"])).stdout).toContain("project list loaded, last refresh failed"),
    );
    expect(warnings(harness).some((line) => line.startsWith("project list refresh failed: "))).toBe(true);
    // The last good data still serves threads.
    expect((await configure(harness, { path: null })).instructions).toBe("scoped");
    aborted = false;
    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "t2" }) });
    await vi.waitFor(async () => {
      const status = (await harness.runCli(["status"])).stdout;
      expect(status).toContain("project list loaded");
      expect(status).not.toContain("last refresh failed");
    });
    expect((await configure(harness, { path: null })).instructions).toBe("scoped");
  });
});

describe("a refresh that throws", () => {
  it.each([
    ["an Error", new Error("recheck broke"), "recheck broke"],
    ["a string", "recheck string", "recheck string"],
  ])("logs a failure of the first refresh and of a thread.created refresh, thrown as %s", async (_label, failure, text) => {
    vi.resetModules();
    vi.doMock("./src/budget.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./src/budget.js")>()),
      budgetReport: () => {
        throw failure;
      },
    }));
    const { harness } = await load();
    expect(warnings(harness).filter((line) => line === `cache refresh failed: ${text}`)).toHaveLength(1);
    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "t" }) });
    await vi.waitFor(() =>
      expect(warnings(harness).filter((line) => line === `cache refresh failed: ${text}`)).toHaveLength(2),
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
      profiles: { file: path.join(home, ".bb", "model-instructions", "profiles.json"), state: "absent", scopes: [], pins: 0 },
      ignoredSettingScopes: [],
      scopes: [{ name: "work", paths: ["/work/one", "/work/two"] }],
      rules: [
        {
          name: "gchat",
          matchers: { provider: "claude-code", scope: ["work"], threads: "top-level" },
          instructionsLength: 12,
          skills: [],
          unresolved: [],
        },
        {
          name: "rules[1]",
          matchers: { model: "m*", project: ["a", "b"], skipProjects: ["c"], skipTitles: ["T*"] },
          instructionsLength: null,
          skills: ["work-*"],
          unresolved: [],
        },
        { name: "rules[2]", matchers: {}, instructionsLength: 3, skills: [], unresolved: [] },
      ],
      skills: [
        { name: "model-instructions", claimedBy: null },
        { name: "other", claimedBy: [] },
        { name: "work-conventions", claimedBy: ["rules[1]"] },
      ],
      unclaimedSkills: ["other"],
      cache: {
        providers: { loaded: true, failed: false, unchecked: [] },
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
        `profiles file: ${path.join(home, ".bb", "model-instructions", "profiles.json")}`,
        "profiles.json: absent",
        "pins: 0",
        "",
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
        "unchecked providers: none",
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
      ignoredSettingScopes: [],
      claudeProfile: { profilesFile: "absent", decision: null, threadId: "thr_cli", pinned: null },
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
        "Claude profile: none (profiles.json is absent; a thread without a pin gets no CLAUDE_CONFIG_DIR and no pin is written)",
        "Claude profile pinned for thread thr_cli: not pinned yet",
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

  it("forces the top-level role with --top-level, even for a child thread", async () => {
    const { harness } = await loadForCheck({ parentThreadId: "thr_parent" });
    const result = JSON.parse((await harness.runCli(["check", "--top-level", "--json"], ctx)).stdout);
    expect(result.target.role).toBe("top-level");
    expect(result.sources.role).toBe("flag");
    expect(result.matched).not.toContain("child-only");
    const noThread = JSON.parse(
      (await harness.runCli(["check", "--top-level", "--provider", "p", "--model", "m", "--json"], {})).stdout,
    );
    expect(noThread.sources.role).toBe("flag");
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
    [["check", "--all", "--top-level"], "check: --all takes no other flag except --json"],
    [["check", "--top-level", "--child"], "check: --top-level and --child cannot be used together"],
    [["check", "--child", "--top-level", "--provider", "p", "--model", "m"], "check: --top-level and --child cannot be used together"],
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
      'unknown command "bogus"\nusage: bb model-instructions status [--json] | check [--provider P] [--model M] [--child | --top-level] [--project <id>] [--path <dir>] [--title T] [--json] | check --all [--json] | setup [--dry-run] [--json] | unpin [<thread-id>] | import-dir-skills [--dry-run] [--json]\n',
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
    expect(text).toMatchObject({ exitCode: 1, stderr: "budget not checkable yet: project list refresh failed; retry after the next refresh (every minute), or see bb model-instructions status\n" });
    const json = await harness.runCli(["check", "--all", "--json"]);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ ok: false, error: "budget not checkable yet: project list refresh failed; retry after the next refresh (every minute), or see bb model-instructions status" });
  });
});

describe("registration", () => {
  it("registers the model-instructions command with its commands", async () => {
    const { harness } = await load();
    expect(harness.registrations.cli?.name).toBe("model-instructions");
    expect(harness.registrations.cli?.commands?.map((command) => command.name)).toEqual([
      "status",
      "check",
      "setup",
      "unpin",
      "import-dir-skills",
    ]);
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

describe("bb model-instructions status: unresolved references", () => {
  it("marks every scope and skills glob that matches nothing, in JSON and in text", async () => {
    const { harness } = await load({
      settings: {
        rules: JSON.stringify({
          scopes: [{ name: "work", paths: ["/work"] }],
          rules: [
            { name: "fine", scope: "work", skills: "work-*", instructions: "ok" },
            { name: "bad", scope: ["work", "gone-*"], skills: ["typo", "other"], instructions: "x" },
          ],
        }),
      },
    });
    const json = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
    expect(json.rules.map((rule: { unresolved: unknown }) => rule.unresolved)).toEqual([
      [],
      [
        { kind: "scope", glob: "gone-*" },
        { kind: "skills", glob: "typo" },
      ],
    ]);
    const text = (await harness.runCli(["status"])).stdout;
    expect(text).toContain('\n  ! scope "gone-*" matches nothing\n  ! skills "typo" matches nothing\n');
    expect(text.match(/matches nothing/g)).toHaveLength(2);
  });
});

describe("startup does not hold up the rules", () => {
  it("registers configure and the command while the project list never resolves", async () => {
    const scopeRoot = path.join(base, "scoped");
    mkdirSync(scopeRoot, { recursive: true });
    const list = vi.fn(async (_args: { signal: AbortSignal }) => new Promise<never>(() => {}));
    const { harness } = await load({
      settings: {
        rules: JSON.stringify({
          scopes: [{ name: "r", paths: [scopeRoot] }],
          rules: [{ instructions: "always" }, { scope: "r", instructions: "scoped" }],
        }),
      },
      sdk: { projects: { list } },
    });
    expect(harness.registrations.cli?.name).toBe("model-instructions");
    expect((await configure(harness)).instructions).toBe("always");
    // The environment path is always a candidate, so a scope matches through it before the list loads.
    expect((await configure(harness, { path: scopeRoot })).instructions).toBe("always\n\nscoped");
    expect((await harness.runCli(["status"])).stdout).toContain("project list not loaded");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal to projects.list", async () => {
    const list = vi.fn(async (_args: { includePersonal: boolean; signal: AbortSignal }) => []);
    await load({ sdk: { projects: { list } } });
    expect(list.mock.calls[0][0].includePersonal).toBe(true);
    expect(list.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("coalesced refreshes", () => {
  it("runs exactly one follow-up refresh for any number of calls made during a refresh", async () => {
    let release: (() => void) | undefined;
    const world = DEFAULT_WORLD();
    const list = vi.fn(async () => {
      if (list.mock.calls.length === 1) await new Promise<void>((resolve) => (release = resolve));
      return world.projects;
    });
    const { harness } = await load({ sdk: { projects: { list } } });
    expect(list).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i += 1)
      await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: `t${i}` }) });
    expect(list).toHaveBeenCalledTimes(1);
    release!();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    // Every mock settles in microtasks, so a third run would have started by now.
    await flushMicrotasks();
    expect(list).toHaveBeenCalledTimes(2);
    expect(harness.sdk.callsTo("providers.list")).toHaveLength(2);
    // Idle again: the next call runs at once.
    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "later" }) });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  });
});

describe("the dedup set of runtime overflows", () => {
  it("holds at most 1000 entries and forgets the oldest first", async () => {
    const { harness } = await load({
      settings: { rules: rules({ name: "guard", instructions: x(3000) }, { name: "extra", instructions: x(1500) }) },
    });
    const lost = () => warnings(harness).filter((line) => line.includes("lost rules")).length;
    for (let i = 0; i < 1000; i += 1) await configure(harness, { thread: `thr_${i}` });
    expect(lost()).toBe(1000);
    await configure(harness, { thread: "thr_999" });
    await configure(harness, { thread: "thr_0" });
    expect(lost()).toBe(1000);
    // The 1001st thread pushes thr_0 out; thr_1 is the oldest left.
    await configure(harness, { thread: "thr_1000" });
    expect(lost()).toBe(1001);
    await configure(harness, { thread: "thr_999" });
    expect(lost()).toBe(1001);
    await configure(harness, { thread: "thr_0" });
    expect(lost()).toBe(1002);
  });
});

describe("checkout paths are normalized at refresh", () => {
  it("resolves a checkout symlink once, and configure does not resolve it again; the environment path is resolved each time", async () => {
    const scopeRoot = path.join(base, "scoped");
    const real = path.join(scopeRoot, "real");
    const elsewhere = path.join(base, "elsewhere");
    mkdirSync(real, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    const link = path.join(base, "checkout-link");
    symlinkSync(real, link);
    const world = DEFAULT_WORLD();
    world.projects = [{ id: "proj_1", name: "bb-plugins", sources: [{ path: link, hostId: "h" }] }];
    const { harness } = await load({
      world,
      settings: { rules: JSON.stringify({ scopes: [{ name: "r", paths: [scopeRoot] }], rules: [{ scope: "r", instructions: "scoped" }] }) },
    });
    expect((await configure(harness, { path: null })).instructions).toBe("scoped");
    // Point the link away: only a second resolution at configure time would notice.
    rmSync(link);
    symlinkSync(elsewhere, link);
    expect((await configure(harness, { path: null })).instructions).toBe("scoped");
    // The environment path is not cached: it is resolved on every call.
    const envLink = path.join(base, "env-link");
    symlinkSync(real, envLink);
    expect((await configure(harness, { project: { id: "no-such" }, path: envLink })).instructions).toBe("scoped");
    rmSync(envLink);
    symlinkSync(elsewhere, envLink);
    expect((await configure(harness, { project: { id: "no-such" }, path: envLink })).instructions).toBeNull();
  });
});

describe("the save check and a symlinked checkout", () => {
  it("still matches a scope through a checkout that is a symlink into it", async () => {
    const scopeRoot = path.join(base, "scoped");
    const real = path.join(scopeRoot, "real");
    mkdirSync(real, { recursive: true });
    const link = path.join(base, "checkout-link");
    symlinkSync(real, link);
    const world = DEFAULT_WORLD();
    world.projects = [{ id: "proj_1", name: "bb-plugins", sources: [{ path: link, hostId: "h" }] }];
    const { harness } = await load({ world });
    const setting = JSON.stringify({
      scopes: [{ name: "r", paths: [scopeRoot] }],
      rules: [
        { name: "a", instructions: x(3000) },
        { name: "b", scope: "r", instructions: x(3000) },
      ],
    });
    await expect(harness.setSettings({ rules: setting })).rejects.toThrow('project "bb-plugins"');
  });
});

describe("the known limit of the save check: the environment path", () => {
  it("does not count a scope matched only through the environment path, but resolves it at runtime", async () => {
    const scopeRoot = path.join(base, "scoped");
    const outside = path.join(base, "outside");
    mkdirSync(path.join(scopeRoot, "worktree"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    const world = DEFAULT_WORLD();
    world.projects = [{ id: "proj_1", name: "bb-plugins", sources: [{ path: outside, hostId: "h" }] }];
    const { harness } = await load({ world });
    const setting = JSON.stringify({
      scopes: [{ name: "r", paths: [scopeRoot] }],
      rules: [
        { name: "a", instructions: x(3000) },
        { name: "b", scope: "r", instructions: x(3000) },
      ],
    });
    // Saved: no thread type of the project's checkouts matches both rules.
    await harness.setSettings({ rules: setting });
    expect(JSON.parse((await harness.runCli(["check", "--all", "--json"])).stdout)).toMatchObject({ ok: true, overflowing: 0 });
    // A thread whose environment (a worktree) is in the scope does match both: rule b is cut, with the notice.
    expect((await configure(harness, { path: path.join(scopeRoot, "worktree") })).instructions).toBe(
      `${x(3000)}\n\n${omittedNotice(1)}`,
    );
    expect(warnings(harness).filter((line) => line.includes("lost rules"))).toHaveLength(1);
    expect((await configure(harness, { path: outside })).instructions).toBe(x(3000));
  });
});
