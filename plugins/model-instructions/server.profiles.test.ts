import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLegacyText } from "./src/rules.js";

const HOST = "host_local";
const REMOTE = "https://git.example.com/acme/app.git";

let base: string;
let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "model-instructions-profiles-server-")));
  home = path.join(base, "home");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(base, { recursive: true, force: true });
  vi.doUnmock("node:url");
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

const profilesPath = () => path.join(home, ".bb", "model-instructions", "profiles.json");
const exportPath = () => path.join(home, ".bb", "dir-skills", "export.json");
const scopesPath = () => path.join(home, ".bb", "dir-skills", "scopes.json");

function put(file: string, content: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

const profileDir = () => path.join(home, ".claude-work");
const WORK_PROFILE = (paths: string[] = ["/w"]) => ({
  scopes: [{ name: "work", paths, claudeConfigDir: "~/.claude-work" }],
});

interface World {
  projects: Array<{ id: string; name: string; gitRemoteUrl?: string; sources?: Array<{ path?: string; hostId?: string }> }>;
}

const DEFAULT_WORLD = (): World => ({
  projects: [
    { id: "proj_w", name: "in-work", sources: [{ path: "/w/app", hostId: HOST }] },
    { id: "proj_e", name: "elsewhere", sources: [{ path: "/elsewhere/app", hostId: HOST }] },
  ],
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

async function pluginAt(root: string) {
  vi.resetModules();
  vi.doMock("node:url", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:url")>();
    return { ...actual, fileURLToPath: () => path.join(root, "server.ts") };
  });
  return (await import("./server.js")).default;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

interface LoadOptions {
  /** The saved config, as JSON text in the old setting's array or object form; stored before the plugin starts. */
  config?: string;
  world?: World;
  sdk?: Record<string, unknown>;
  kv?: Record<string, unknown>;
  skills?: string[];
}

async function load(options: LoadOptions = {}) {
  const world = options.world ?? DEFAULT_WORLD();
  const skills = options.skills ?? ["work-conventions"];
  const host = createFakePluginHost({
    pluginId: "model-instructions",
    agentSkillIds: ["model-instructions", ...skills],
    sdk: {
      providers: {
        list: async () => [{ id: "claude-code", available: true }],
        models: async () => ({ models: [{ id: "opus", model: "opus" }], modelLoadError: null }),
      },
      projects: { list: async () => world.projects },
      ...options.sdk,
    },
  });
  for (const [key, value] of Object.entries(options.kv ?? {})) await host.bb.storage.kv.set(key, value);
  if (options.config !== undefined) await host.bb.storage.kv.set("config", parseLegacyText(options.config));
  const create = await pluginAt(skillsRoot(["model-instructions", ...skills]));
  await create(host.bb);
  await flush();
  return { host, harness: host.harness, world };
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** A form save: the RPC `saveConfig` with a config given in the old setting's text form. */
const save = (harness: Loaded["harness"], text: string) =>
  harness.callRpc("saveConfig", { config: parseLegacyText(text) });

const env = (threadId: string, projectId = "proj_w") => ({ threadId, projectId, hostId: HOST });
const warnings = (loaded: Loaded) =>
  loaded.harness.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message);
const pinOf = (loaded: Loaded, threadId: string) =>
  loaded.host.bb.storage.kv.get(`claude-config-dir:${threadId}`);
const ignoredText = (name: string) =>
  `ignored saved scope "${name}": a profile scope with that name comes from profiles.json`;

function configure(harness: Loaded["harness"], over: { project?: string; path?: string | null; thread?: string } = {}) {
  return harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: over.thread ?? "thr_c", parentThreadId: null, title: null },
      project: { id: over.project ?? "proj_w", name: "p" },
      environment: { path: over.path === null ? undefined : (over.path ?? "/w/app") },
      provider: { id: "claude-code", model: "opus" },
    }),
  );
}

const SETTING_SCOPE_AND_RULE = (paths: string[]) =>
  JSON.stringify({
    scopes: [{ name: "work", paths }],
    rules: [{ name: "gchat", scope: "work", skills: "work-*", instructions: "Work text." }],
  });

describe("the 31dcde3 boundary: the file defines the profile scope", () => {
  it("ignores a setting scope named like a profile scope: warns at load, and shows it in status and check", async () => {
    put(profilesPath(), WORK_PROFILE());
    mkdirSync(profileDir());
    const loaded = await load({ config: SETTING_SCOPE_AND_RULE(["/elsewhere"]) });
    expect(warnings(loaded)).toContain(ignoredText("work"));
    const { harness } = loaded;
    const status = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
    expect(status.ignoredSettingScopes).toEqual(["work"]);
    expect(status.scopes).toEqual([{ name: "work", paths: ["/w"] }]);
    expect((await harness.runCli(["status"])).stdout).toContain(ignoredText("work"));
    const check = await harness.runCli(["check", "--provider", "claude-code", "--model", "opus", "--project", "proj_w"]);
    expect(check.stdout).toContain(ignoredText("work"));
    expect(JSON.parse((await harness.runCli(["check", "--json", "--provider", "claude-code", "--model", "opus"])).stdout).ignoredSettingScopes).toEqual(["work"]);
  });

  it("(a) changing the setting scope's paths never changes a profile decision", async () => {
    put(profilesPath(), WORK_PROFILE());
    mkdirSync(profileDir());
    const loaded = await load({ config: SETTING_SCOPE_AND_RULE(["/elsewhere"]) });
    const { harness } = loaded;
    const dir = (threadId: string, project: string) =>
      harness.resolveProviderEnv("claude-code", env(threadId, project)).then((entries) => entries.map((e) => e.value));
    expect(await dir("t1", "proj_w")).toEqual([profileDir()]);
    expect(await dir("t2", "proj_e")).toEqual([]);
    for (const paths of [["/w"], ["/elsewhere", "/w"], ["/nowhere"]]) {
      await save(harness, SETTING_SCOPE_AND_RULE(paths));
      expect(await dir(`in-${paths.join("")}`, "proj_w")).toEqual([profileDir()]);
      expect(await dir(`out-${paths.join("")}`, "proj_e")).toEqual([]);
    }
  });

  it("(b) changing the file's paths does, once the plugin reloads", async () => {
    put(profilesPath(), WORK_PROFILE());
    mkdirSync(profileDir());
    const first = await load();
    expect((await first.harness.resolveProviderEnv("claude-code", env("t1", "proj_w"))).map((e) => e.value)).toEqual([profileDir()]);
    put(profilesPath(), WORK_PROFILE(["/elsewhere"]));
    const second = await load();
    expect(await second.harness.resolveProviderEnv("claude-code", env("t2", "proj_w"))).toEqual([]);
    expect((await second.harness.resolveProviderEnv("claude-code", env("t3", "proj_e"))).map((e) => e.value)).toEqual([profileDir()]);
  });

  it("lets rules name a profile scope: the save check accepts it, and the rule matches by the file's paths", async () => {
    put(profilesPath(), WORK_PROFILE());
    const { harness } = await load();
    await save(harness, JSON.stringify([{ name: "gchat", scope: "work", skills: "work-*", instructions: "Work text." }]));
    expect(await configure(harness)).toMatchObject({ instructions: "Work text.", skills: ["model-instructions", "work-conventions"] });
    expect((await configure(harness, { project: "proj_e", path: "/elsewhere/app" })).instructions).toBeNull();
    const status = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
    expect(status.scopes).toEqual([{ name: "work", paths: ["/w"] }]);
  });

  it("rejects that rule on save while profiles.json is absent, and loads it from storage with a warning", async () => {
    const rule = JSON.stringify([{ name: "gchat", scope: "work", instructions: "Work text." }, { name: "guard", instructions: "Guard." }]);
    const { harness } = await load();
    await expect(save(harness, rule)).rejects.toThrow('gchat: scope "work" matches no defined scope');
    const stored = await load({ config: rule });
    expect(warnings(stored)).toContain('gchat: scope "work" match nothing');
    expect((await configure(stored.harness)).instructions).toBe("Guard.");
  });
});

describe("profiles.json states, at plugin level", () => {
  const states = [
    ["absent", () => undefined],
    ["malformed", () => put(profilesPath(), '{ "scopes": [ { "name": "work" } ] }')],
    ["valid", () => put(profilesPath(), WORK_PROFILE())],
  ] as const;

  describe.each(states)("%s", (state, prepare) => {
    beforeEach(() => {
      mkdirSync(profileDir());
      prepare();
    });

    it("serves an existing pin and keeps it, even when its dir is gone", async () => {
      const gone = path.join(home, ".gone");
      const loaded = await load({ kv: { "claude-config-dir:t1": { dir: gone, scope: "old" } } });
      expect((await loaded.harness.resolveProviderEnv("claude-code", env("t1"))).map((e) => e.value)).toEqual([gone]);
      expect(await pinOf(loaded, "t1")).toEqual({ dir: gone, scope: "old" });
      expect(warnings(loaded).join(" ")).toContain("not a directory now");
    });

    it("pins a thread without a pin only while the file is valid", async () => {
      const loaded = await load();
      const out = await loaded.harness.resolveProviderEnv("claude-code", env("t1"));
      if (state === "valid") {
        expect(out.map((e) => e.value)).toEqual([profileDir()]);
        expect(await pinOf(loaded, "t1")).toEqual({ dir: profileDir(), scope: "work" });
      } else {
        expect(out).toEqual([]);
        expect(await pinOf(loaded, "t1")).toBeUndefined();
      }
    });

    it("keeps rules and skills working", async () => {
      const loaded = await load({
        config: JSON.stringify([{ name: "guard", instructions: "Guard.", skills: "work-*" }]),
      });
      expect(await configure(loaded.harness)).toMatchObject({ instructions: "Guard.", skills: ["model-instructions", "work-conventions"] });
    });

    it("says so in status", async () => {
      const loaded = await load();
      const text = (await loaded.harness.runCli(["status"])).stdout;
      const json = JSON.parse((await loaded.harness.runCli(["status", "--json"])).stdout);
      expect(json.profiles.state).toBe(state);
      if (state === "malformed") {
        expect(text).toMatch(/^profiles file: .*\nprofiles\.json: malformed — .*scopes/);
        expect(json.profiles.message).toMatch(/claudeConfigDir/);
      } else expect(text).toContain(`profiles.json: ${state}\n`);
      if (state === "valid")
        expect(text).toContain(`  profile scope work: /w -> ${profileDir()} (directory exists)`);
    });
  });

  it("warns loudly at load for a malformed file, and quietly for an absent one", async () => {
    put(profilesPath(), "{");
    const malformed = await load();
    expect(warnings(malformed).join("\n")).toMatch(/profiles\.json is malformed and ignored: not valid JSON.*no new Claude profile is pinned/);
    rmSync(profilesPath());
    const absent = await load();
    expect(warnings(absent).join("\n")).not.toContain("profiles.json");
    expect(absent.harness.logEntries.map((e) => e.message)).toContain(
      "profiles.json is absent: a thread without a pin gets no CLAUDE_CONFIG_DIR, and no pin is written",
    );
  });

  it("warns at load for a profile directory that is missing, and lists it in status", async () => {
    put(profilesPath(), WORK_PROFILE());
    const loaded = await load();
    expect(warnings(loaded)).toContain(
      `profile scope "work" claudeConfigDir ${profileDir()} is not a directory; threads there start with the default profile`,
    );
    expect((await loaded.harness.runCli(["status"])).stdout).toContain("(not a directory)");
    expect(await loaded.harness.resolveProviderEnv("claude-code", env("t1"))).toEqual([]);
    expect(await pinOf(loaded, "t1")).toEqual({ dir: null, scope: null, reason: "missing-dir" });
  });

  it("counts the pins in status", async () => {
    const loaded = await load({ kv: { "claude-config-dir:a": { dir: null, scope: null }, "claude-config-dir:b": { dir: null, scope: null }, other: 1 } });
    expect(JSON.parse((await loaded.harness.runCli(["status", "--json"])).stdout).profiles.pins).toBe(2);
    expect((await loaded.harness.runCli(["status"])).stdout).toContain("pins: 2\n");
  });

  it("answers a process with no thread from the file alone", async () => {
    put(profilesPath(), WORK_PROFILE());
    mkdirSync(profileDir());
    const loaded = await load();
    const out = await loaded.harness.resolveProviderEnv("claude-code", { threadId: null, projectId: "proj_w", hostId: HOST });
    expect(out.map((e) => e.value)).toEqual([profileDir()]);
    expect(loaded.host.bb.storage.kv.list("claude-config-dir:")).resolves.toEqual([]);
  });
});

describe("check: the profile decision and the calling thread's pin", () => {
  it("shows the decision by project checkout and the pin of the calling thread", async () => {
    put(profilesPath(), WORK_PROFILE());
    mkdirSync(profileDir());
    const loaded = await load({
      kv: { "claude-config-dir:thr_cli": { dir: profileDir(), scope: "work" } },
      sdk: { threads: { get: async () => ({ providerId: "claude-code", parentThreadId: null, projectId: "proj_w", title: null, environment: { path: "/w/app" } }), defaultExecutionOptions: async () => ({ model: "opus" }) } },
    });
    const ctx = { threadId: "thr_cli", projectId: "proj_w", cwd: "/w/app" };
    const text = (await loaded.harness.runCli(["check"], ctx)).stdout;
    expect(text).toContain(`Claude profile (by project checkout, all hosts): ${profileDir()}  (scope work)`);
    expect(text).toContain(`Claude profile pinned for thread thr_cli: ${profileDir()}`);
    expect(JSON.parse((await loaded.harness.runCli(["check", "--json"], ctx)).stdout).claudeProfile).toEqual({
      profilesFile: "valid",
      decision: { status: "profile", dir: profileDir(), scope: "work", conflict: [] },
      threadId: "thr_cli",
      pinned: { dir: profileDir(), scope: "work" },
    });
    const elsewhere = await loaded.harness.runCli(["check", "--project", "proj_e", "--path", "/elsewhere/app"], ctx);
    expect(elsewhere.stdout).toContain("Claude profile (by project checkout, all hosts): none");
  });

  it("says what a malformed file means for the decision", async () => {
    put(profilesPath(), "{");
    const loaded = await load();
    const out = (await loaded.harness.runCli(["check", "--provider", "claude-code", "--model", "opus", "--project", "proj_w"])).stdout;
    expect(out).toMatch(/Claude profile: none \(profiles\.json: malformed — not valid JSON/);
  });
});

describe("the project cache feeds the profile decision", () => {
  it("refreshes once for an unknown project, so a project created since the last refresh resolves", async () => {
    put(profilesPath(), WORK_PROFILE());
    mkdirSync(profileDir());
    const loaded = await load();
    loaded.world.projects = [{ id: "proj_new", name: "new", sources: [{ path: "/w/new", hostId: HOST }] }];
    const before = loaded.harness.sdk.callsTo("projects.list").length;
    const out = await loaded.harness.resolveProviderEnv("claude-code", env("t_new", "proj_new"));
    expect(out.map((e) => e.value)).toEqual([profileDir()]);
    expect(loaded.harness.sdk.callsTo("projects.list").length).toBe(before + 1);
    await loaded.harness.resolveProviderEnv("claude-code", env("t_known", "proj_new"));
    expect(loaded.harness.sdk.callsTo("projects.list").length).toBe(before + 1);
  });

  it("ignores checkouts of other hosts for a thread, and counts them in check", async () => {
    put(profilesPath(), WORK_PROFILE());
    mkdirSync(profileDir());
    const loaded = await load({ world: { projects: [{ id: "proj_r", name: "r", sources: [{ path: "/w/app", hostId: "host_remote" }] }] } });
    expect(await loaded.harness.resolveProviderEnv("claude-code", env("t1", "proj_r"))).toEqual([]);
    const out = await loaded.harness.runCli(["check", "--provider", "claude-code", "--model", "opus", "--project", "proj_r"]);
    expect(out.stdout).toContain(`${profileDir()}  (scope work)`);
  });

  it("pins the default profile for a project it cannot find, and says how to recover", async () => {
    put(profilesPath(), WORK_PROFILE());
    const loaded = await load();
    expect(await loaded.harness.resolveProviderEnv("claude-code", env("t_unknown", "proj_unknown"))).toEqual([]);
    expect(warnings(loaded).join("\n")).toContain("project proj_unknown not resolved");
    expect(warnings(loaded).join("\n")).toContain("bb model-instructions unpin t_unknown");
    expect(await pinOf(loaded, "t_unknown")).toEqual({ dir: null, scope: null, reason: "unknown-project" });
  });

  it("gives up on a refresh after the lookup timeout", async () => {
    put(profilesPath(), WORK_PROFILE());
    const loaded = await load({ sdk: { projects: { list: () => new Promise(() => {}) } } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = loaded.harness.resolveProviderEnv("claude-code", env("t_slow", "proj_slow"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toEqual([]);
    expect(await pinOf(loaded, "t_slow")).toEqual({ dir: null, scope: null, reason: "unknown-project" });
  });

  it("warns when the provider env contribution is unavailable", async () => {
    const host = createFakePluginHost({
      pluginId: "model-instructions",
      agentSkillIds: ["model-instructions"],
      sdk: { projects: { list: async () => [] }, providers: { list: async () => [], models: async () => ({ models: [], modelLoadError: null }) } },
    });
    const create = await pluginAt(skillsRoot(["model-instructions"]));
    await create({ ...host.bb, providers: {} } as unknown as BbPluginApi);
    expect(host.harness.logEntries).toContainEqual(
      expect.objectContaining({ level: "warn", message: expect.stringContaining("experimental_contributeEnv unavailable") }),
    );
  });
});

describe("unpin", () => {
  it("forgets the pin of the calling thread by default, so the next turn resolves afresh", async () => {
    put(profilesPath(), WORK_PROFILE());
    mkdirSync(profileDir());
    const loaded = await load({ kv: { "claude-config-dir:thr_cur": { dir: null, scope: null } } });
    expect(await loaded.harness.resolveProviderEnv("claude-code", env("thr_cur"))).toEqual([]);
    const result = await loaded.harness.runCli(["unpin"], { threadId: "thr_cur" });
    expect(result.stdout).toContain("thread thr_cur: removed pin (default profile)");
    expect((await loaded.harness.resolveProviderEnv("claude-code", env("thr_cur"))).map((e) => e.value)).toEqual([profileDir()]);
    expect((await loaded.harness.runCli(["unpin", "thr_other"])).stdout).toBe("thread thr_other: no pin\n");
    expect((await loaded.harness.runCli(["unpin"])).exitCode).toBe(2);
    expect((await loaded.harness.runCli(["unpin", "--json"])).stderr).toContain("usage: bb model-instructions unpin");
  });
});

/** A work tree with a profile directory, a marketplace and a checkout, as setup detects them. */
function acmeTree(): string {
  const profile = path.join(home, ".claude-acme");
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    path.join(profile, "settings.json"),
    JSON.stringify({ extraKnownMarketplaces: { acme: { source: { source: "git", url: "git@git.example.com:acme/marketplace.git" } } } }),
  );
  const app = path.join(home, "src", "acme", "app");
  mkdirSync(path.join(app, ".git"), { recursive: true });
  writeFileSync(path.join(app, ".git", "config"), `[remote "origin"]\n\turl = ${REMOTE}\n`);
  return app;
}

function setupWorld(app: string): LoadOptions {
  return {
    world: { projects: [{ id: "proj_app", name: "app", gitRemoteUrl: REMOTE, sources: [{ path: app, hostId: HOST }] }] },
    sdk: {
      plugins: {
        getSettings: async ({ pluginId }: { pluginId: string }) => {
          if (pluginId !== "provider-acp") throw new Error("404");
          return { values: { customAgents: JSON.stringify([{ id: "claude-acme", env: { CLAUDE_CONFIG_DIR: "~/.claude-acme" } }]) } };
        },
      },
      threads: { get: async () => ({ projectId: "proj_app" }) },
    },
  };
}

describe("setup", () => {
  it("is listed with its usage, and does nothing on a dry run", async () => {
    const loaded = await load(setupWorld(acmeTree()));
    expect(loaded.harness.registrations.cli?.commands.find((c) => c.name === "setup")?.usage).toBe(
      "bb model-instructions setup [--dry-run] [--json]",
    );
    const dry = await loaded.harness.runCli(["setup", "--dry-run", "--json"]);
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ outcome: "dry-run", candidate: { name: "work", paths: ["~/src/acme"], claudeConfigDir: "~/.claude-acme" } });
    expect(existsSync(profilesPath())).toBe(false);
  });

  it("writes profiles.json with { name, paths, claudeConfigDir } only, and applies it without a reload", async () => {
    const app = acmeTree();
    const loaded = await load(setupWorld(app));
    expect(await loaded.harness.resolveProviderEnv("claude-code", env("t_before", "proj_app"))).toEqual([]);
    const result = await loaded.harness.runCli(["setup", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(profilesPath(), "utf8"))).toEqual({
      scopes: [{ name: "work", paths: ["~/src/acme"], claudeConfigDir: "~/.claude-acme" }],
    });
    expect((await loaded.harness.resolveProviderEnv("claude-code", env("t_after", "proj_app"))).map((e) => e.value)).toEqual([
      path.join(home, ".claude-acme"),
    ]);
    expect(JSON.parse((await loaded.harness.runCli(["status", "--json"])).stdout).profiles.state).toBe("valid");
    expect((await loaded.harness.runCli(["setup"])).exitCode).toBe(2);
    expect((await loaded.harness.runCli(["setup", "--force"])).exitCode).toBe(2);
  });

  it("lets a thread pinned to the default profile pick up the new scope after unpin", async () => {
    const loaded = await load(setupWorld(acmeTree()));
    await loaded.harness.resolveProviderEnv("claude-code", env("t_old", "proj_app"));
    expect(await pinOf(loaded, "t_old")).toBeUndefined();
    await loaded.host.bb.storage.kv.set("claude-config-dir:t_old", { dir: null, scope: null });
    const result = await loaded.harness.runCli(["setup"]);
    expect(result.stdout).toContain("bb model-instructions unpin t_old");
    await loaded.harness.runCli(["unpin", "t_old"]);
    expect(await loaded.harness.resolveProviderEnv("claude-code", env("t_old", "proj_app"))).toEqual([
      expect.objectContaining({ name: "CLAUDE_CONFIG_DIR" }),
    ]);
  });

  it("leaves everything alone and gives the reason when nothing matches", async () => {
    const app = acmeTree();
    rmSync(path.join(home, ".claude-acme", "settings.json"));
    const loaded = await load(setupWorld(app));
    const result = await loaded.harness.runCli(["setup"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("no-self-hosted-marketplace");
    expect(existsSync(profilesPath())).toBe(false);
  });
});

describe("import-dir-skills through the plugin", () => {
  const scopes = () => ({
    scopes: [
      { name: "work", paths: ["/w"], skills: ["work-*"], claudeConfigDir: "~/.claude-work" },
      { name: "plain", paths: ["/p"], skills: ["work-*"] },
      { name: "work2", paths: ["~/workspace/work"], skills: ["work-*"] },
    ],
  });

  it("is listed with its usage", async () => {
    const loaded = await load();
    expect(loaded.harness.registrations.cli?.commands.find((c) => c.name === "import-dir-skills")?.usage).toBe(
      "bb model-instructions import-dir-skills [--dry-run] [--json]",
    );
  });

  it("needs export.json", async () => {
    const result = await (await load()).harness.runCli(["import-dir-skills"]);
    expect(result).toMatchObject({
      exitCode: 1,
      stderr: "import-dir-skills: ~/.bb/dir-skills/export.json not found; run bb dir-skills export first\n",
    });
  });

  it("imports through the real settings write: the save check passes, profiles apply at once, the pins are served", async () => {
    mkdirSync(profileDir());
    put(scopesPath(), scopes());
    put(exportPath(), {
      uiScopes: [{ name: "ui", paths: ["/ui"], skills: ["work-*"] }],
      pins: [
        { threadId: "t_prof", pin: { dir: profileDir(), scope: "work" } },
        { threadId: "t_default", pin: { dir: null, scope: null } },
        { threadId: "t_bad", pin: { dir: "/not/a/profile", scope: "x" } },
      ],
    });
    const existing = [{ name: "guard", instructions: "Guard." }];
    const loaded = await load({ config: JSON.stringify(existing) });
    const { harness } = loaded;
    const dry = await harness.runCli(["import-dir-skills", "--dry-run"]);
    expect(dry.exitCode).toBe(0);
    expect(existsSync(profilesPath())).toBe(false);
    expect(await pinOf(loaded, "t_prof")).toBeUndefined();

    const result = await harness.runCli(["import-dir-skills"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pins: 2 imported, 0 kept, 1 rejected");
    expect(JSON.parse(readFileSync(profilesPath(), "utf8"))).toEqual({
      scopes: [{ name: "work", paths: ["/w"], claudeConfigDir: "~/.claude-work" }],
    });
    const status = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
    expect(status.rules.map((rule: { name: string; matchers: { scope?: string[] }; skills: string[] }) => [rule.name, rule.matchers.scope, rule.skills])).toEqual([
      ["guard", undefined, []],
      ["dir-skills:work", ["work"], ["work-*"]],
      ["dir-skills:plain", ["plain"], ["work-*"]],
      ["dir-skills:work2", ["work2"], ["work-*"]],
      ["dir-skills:ui", ["ui"], ["work-*"]],
    ]);
    expect(status.scopes.map((scope: { name: string }) => scope.name)).toEqual(["work", "plain", "work2", "ui"]);
    // The profile scope is in force now, and the claims reach threads in the right trees.
    expect(await configure(harness)).toMatchObject({ instructions: "Guard.", skills: ["model-instructions", "work-conventions"] });
    expect((await configure(harness, { project: "proj_e", path: "/elsewhere/app" })).skills).toEqual(["model-instructions"]);
    expect((await harness.resolveProviderEnv("claude-code", env("t_prof")))).toEqual([expect.objectContaining({ value: profileDir() })]);
    expect((await harness.resolveProviderEnv("claude-code", env("t_default"))).length).toBe(0);
    expect(await pinOf(loaded, "t_bad")).toBeUndefined();
    expect((await harness.resolveProviderEnv("claude-code", env("t_new"))).map((e) => e.value)).toEqual([profileDir()]);
  });

  it("reports the setting's rejection, and writes no pin", async () => {
    put(scopesPath(), { scopes: [{ name: "plain", paths: ["/p"], skills: ["work-*"] }] });
    put(exportPath(), { uiScopes: [], pins: [{ threadId: "t1", pin: { dir: null, scope: null } }] });
    const loaded = await load({ config: JSON.stringify([{ instructions: "x" }]) });
    // Break the cache so the save-time budget check cannot run for the existing text rule.
    const failing = await load({
      config: JSON.stringify([{ instructions: "x" }]),
      sdk: { providers: { list: async () => { throw new Error("down"); } } },
    });
    const result = await failing.harness.runCli(["import-dir-skills"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/the saved config would be rejected \(nothing was written\):\n  budget not checkable yet/);
    expect(await pinOf(failing, "t1")).toBeUndefined();
    expect(loaded).toBeDefined();
  });

  it("recovers a half-finished import: profile scopes already in profiles.json are recognised on the next run", async () => {
    mkdirSync(profileDir());
    put(scopesPath(), { scopes: [{ name: "work", paths: ["/w"], skills: ["work-*"], claudeConfigDir: "~/.claude-work" }] });
    put(exportPath(), { uiScopes: [], pins: [] });
    const loaded = await load();
    const once = await loaded.harness.runCli(["import-dir-skills", "--json"]);
    expect(JSON.parse(once.stdout).profileScopes).toHaveLength(1);
    const twice = JSON.parse((await loaded.harness.runCli(["import-dir-skills", "--json"])).stdout);
    expect(twice.profileScopes).toEqual([]);
    expect(twice.settingChanged).toBe(false);
  });
});

describe("registration", () => {
  it("shows the Claude profile commands in the usage line and the summary", async () => {
    const { harness } = await load();
    expect(harness.registrations.cli?.summary).toContain("Claude profiles");
    const bogus = await harness.runCli(["bogus"]);
    expect(bogus.stderr).toContain("setup [--dry-run] [--json] | unpin [<thread-id>] | import-dir-skills [--dry-run] [--json]");
  });

  it("fires thread.created refreshes into the profile decision", async () => {
    put(profilesPath(), WORK_PROFILE());
    mkdirSync(profileDir());
    const loaded = await load();
    loaded.world.projects = [{ id: "proj_created", name: "c", sources: [{ path: "/w/created", hostId: HOST }] }];
    await loaded.harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_created" }) });
    await vi.waitFor(async () =>
      expect((await loaded.harness.resolveProviderEnv("claude-code", env("t_c", "proj_created"))).map((e) => e.value)).toEqual([profileDir()]),
    );
  });
});
