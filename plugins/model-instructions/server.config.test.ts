import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelInstructionsRpcContract, type ConfigState } from "./rpc-contract.js";
import { parseRawConfig } from "./src/rules.js";

const x = (length: number) => "x".repeat(length);

let base: string;
let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "model-instructions-config-")));
  home = path.join(base, "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(base, { recursive: true, force: true });
  vi.doUnmock("node:url");
  vi.restoreAllMocks();
  vi.resetModules();
});

const SKILLS = ["work-conventions", "other"];

function skillsRoot(): string {
  const root = path.join(base, "plugin");
  for (const name of ["model-instructions", ...SKILLS]) {
    const dir = path.join(root, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture ${name}\n---\nbody`);
  }
  return root;
}

async function pluginAt() {
  const root = skillsRoot();
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

interface Options {
  /** What the host answers for the old `rules` setting; left out, the call is not stubbed and throws. */
  legacy?: unknown;
  /** Stored under kv `config` before the plugin starts. */
  stored?: unknown;
  /** Stored under kv `legacyRules` before the plugin starts. */
  kept?: unknown;
  sdk?: Record<string, unknown>;
}

function worldSdk(sdk: Record<string, unknown> = {}) {
  return {
    providers: {
      list: async () => [{ id: "claude-code", available: true }],
      models: async () => ({ models: [{ id: "opus", model: "opus" }], modelLoadError: null }),
    },
    projects: { list: async () => [{ id: "proj_1", name: "bb-plugins", sources: [] }] },
    ...sdk,
  };
}

async function load(options: Options = {}) {
  const getSettings = vi.fn(async () => ({ values: { rules: options.legacy } }));
  const host = createFakePluginHost({
    pluginId: "model-instructions",
    agentSkillIds: ["model-instructions", ...SKILLS],
    sdk: {
      ...worldSdk(options.sdk),
      ...("legacy" in options ? { plugins: { getSettings } } : {}),
    },
  });
  if (options.stored !== undefined) await host.bb.storage.kv.set("config", options.stored);
  if (options.kept !== undefined) await host.bb.storage.kv.set("legacyRules", options.kept);
  const create = await pluginAt();
  await create(host.bb);
  await flush();
  return { host, harness: host.harness, kv: host.bb.storage.kv, getSettings, create };
}

type Loaded = Awaited<ReturnType<typeof load>>;

const state = (loaded: Loaded) => loaded.harness.callRpc("getState", null) as Promise<ConfigState>;
const save = (loaded: Loaded, config: unknown) => loaded.harness.callRpc("saveConfig", { config }) as Promise<ConfigState>;
const logs = (loaded: Loaded, level: string) =>
  loaded.harness.logEntries.filter((entry) => entry.level === level).map((entry) => entry.message);

const raw = (value: unknown) => parseRawConfig(value);
const GUARD = { name: "guard", instructions: "Guard." };

function configure(loaded: Loaded, over: { path?: string; thread?: string } = {}) {
  return loaded.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: over.thread ?? "thr_1", parentThreadId: null, title: null },
      project: { id: "proj_1", name: "bb-plugins" },
      environment: { path: over.path ?? "/tmp/none" },
      provider: { id: "claude-code", model: "opus" },
    }),
  );
}

function put(file: string, content: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}
const profilesPath = () => path.join(home, ".bb", "model-instructions", "profiles.json");

describe("the one-time import of the old rules setting", () => {
  const SAVED_LINE = (n: number, s: number, v: number) =>
    `config saved from legacy setting: ${n} rules, ${s} scopes, ${v} vars`;

  it("imports the array form, normalizing it, and logs the one line", async () => {
    const loaded = await load({
      legacy: JSON.stringify([
        { name: "a", provider: "claude-code", project: "bb-*", skipTitles: "Help: *", instructions: ["one", "two"] },
        { skills: "work-*", threads: "child" },
      ]),
    });
    expect(await loaded.kv.get("config")).toEqual({
      vars: {},
      scopes: [],
      rules: [
        { name: "a", provider: "claude-code", project: ["bb-*"], skipTitles: ["Help: *"], threads: "any", instructions: "one\ntwo" },
        { skills: ["work-*"], threads: "child" },
      ],
    });
    expect(logs(loaded, "info")).toContain(SAVED_LINE(2, 0, 0));
    expect((await configure(loaded)).instructions).toBe("one\ntwo");
    expect((await state(loaded)).loadError).toBeNull();
    expect(await loaded.kv.get("legacyRules")).toBeUndefined();
  });

  it("imports the object form with its vars unexpanded, its scopes and its rules", async () => {
    const loaded = await load({
      legacy: JSON.stringify({
        vars: { gchat: "Chat text." },
        scopes: [{ name: "work", paths: ["/work"] }],
        rules: [{ name: "r", scope: "work", skills: ["work-*"], instructions: "Say: {{gchat}}" }],
      }),
    });
    expect(await loaded.kv.get("config")).toEqual({
      vars: { gchat: "Chat text." },
      scopes: [{ name: "work", paths: ["/work"] }],
      rules: [{ name: "r", scope: ["work"], skills: ["work-*"], threads: "any", instructions: "Say: {{gchat}}" }],
    });
    expect(logs(loaded, "info")).toContain(SAVED_LINE(1, 1, 1));
    expect((await configure(loaded, { path: "/work/app" })).instructions).toBe("Say: Chat text.");
  });

  it("imports an empty list: a new install's default value", async () => {
    const loaded = await load({ legacy: "[]" });
    expect(await loaded.kv.get("config")).toEqual({ vars: {}, scopes: [], rules: [] });
    expect(logs(loaded, "info")).toContain(SAVED_LINE(0, 0, 0));
  });

  // The save-only gate, both directions: today's rules are carried over as they are, but the same value
  // is refused when it is saved through the form or `import`.
  describe.each([
    {
      label: "an unresolved scope and skill reference",
      config: { rules: [{ name: "gchat", scope: "work", skills: "typo-*", instructions: "x" }] },
      message: 'gchat: scope "work" matches no defined scope',
      sdk: {},
    },
    {
      label: "a rule set that is over budget",
      config: { rules: [{ instructions: x(3000) }, { instructions: x(3000) }] },
      message: "over the 4096-character limit",
      sdk: {},
    },
    {
      label: "a text rule while the caches are not loaded",
      config: { rules: [{ instructions: "x" }] },
      message: "budget not checkable yet: provider list refresh failed",
      sdk: {
        providers: {
          list: async () => {
            throw new Error("providers down");
          },
          models: async () => ({ models: [], modelLoadError: null }),
        },
      },
    },
  ])("with $label", ({ config, message, sdk }) => {
    it("is imported, then refused by the RPC and by import, with nothing stored by them", async () => {
      const loaded = await load({ legacy: JSON.stringify(config), sdk });
      const stored = await loaded.kv.get("config");
      expect(stored).toEqual(raw(config));
      expect(logs(loaded, "info")).toContain(SAVED_LINE(config.rules.length, 0, 0));
      expect(await state(loaded)).toMatchObject({ loadError: null });

      await expect(save(loaded, raw(config))).rejects.toThrow(message);
      const file = path.join(base, "same.json");
      writeFileSync(file, JSON.stringify(raw(config)));
      const result = await loaded.harness.runCli(["import", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message);
      expect(await loaded.kv.get("config")).toEqual(stored);
    });
  });

  it("keeps malformed old text and its error, shows them in the banner state and in export --legacy, and runs with no rules", async () => {
    const text = '[{"instructions": "x", ';
    const loaded = await load({ legacy: text });
    expect(await loaded.kv.get("config")).toBeUndefined();
    const record = (await loaded.kv.get("legacyRules")) as { text: string; error: string };
    expect(record.text).toBe(text);
    expect(record.error).toMatch(/^not valid JSON: /);
    expect(await state(loaded)).toMatchObject({
      config: { vars: {}, scopes: [], rules: [] },
      loadError: { message: record.error, legacyText: text },
    });
    expect(await loaded.harness.runCli(["export", "--legacy"])).toMatchObject({ exitCode: 0, stdout: text });
    expect(logs(loaded, "warn").some((line) => line.startsWith("the old rules setting was not imported: not valid JSON"))).toBe(true);
    expect((await configure(loaded)).instructions).toBeNull();
  });

  it.each([
    ["a rule that fails the structural checks", JSON.stringify([{ name: "r" }]), 'a rule needs "instructions", "skills", or both'],
    // v0.1.11 kept {{name}} in an array-form rule as literal text; the stored config always expands.
    ["a {{name}} in the array form, which has no vars", JSON.stringify([{ instructions: "{{literal}} text" }]), "rules[0]: unknown variable {{literal}}"],
    ["a scope with an unknown key", JSON.stringify({ scopes: [{ name: "w", paths: ["/w"], claudeConfigDir: "/x" }], rules: [] }), "claudeConfigDir"],
  ])("keeps the text of %s instead of importing it", async (_label, text, message) => {
    const loaded = await load({ legacy: text });
    expect(await loaded.kv.get("config")).toBeUndefined();
    expect(await state(loaded)).toMatchObject({ loadError: { message: expect.stringContaining(message), legacyText: text } });
  });

  it.each([
    ["a setting with no value", {}, "no old rules setting to import"],
    ["a blank value", "  \n ", "no old rules setting to import"],
    ["an empty string", "", "no old rules setting to import"],
    ["a value that is not text", 5, "no old rules setting to import"],
  ])("does nothing for %s, and only logs at debug level", async (_label, legacy, message) => {
    const loaded = await load({ legacy });
    expect(await loaded.kv.get("config")).toBeUndefined();
    expect(await loaded.kv.get("legacyRules")).toBeUndefined();
    expect(loaded.harness.logEntries.filter((entry) => entry.level === "debug").map((entry) => entry.message)).toContain(message);
    expect(logs(loaded, "info").some((line) => line.startsWith("config saved"))).toBe(false);
    expect(logs(loaded, "warn")).toEqual([]);
    expect((await state(loaded)).loadError).toBeNull();
  });

  it("does nothing, at debug level, when the host cannot be asked", async () => {
    const loaded = await load();
    expect(await loaded.kv.get("config")).toBeUndefined();
    expect(loaded.harness.logEntries).toContainEqual({
      level: "debug",
      message: expect.stringContaining("the old rules setting could not be read: "),
    });
    expect(logs(loaded, "warn")).toEqual([]);
  });

  describe("once kv holds a config", () => {
    it("ignores the old setting: it is not even read, and a different value changes nothing", async () => {
      const loaded = await load({ legacy: JSON.stringify([{ instructions: "from the old setting" }]) });
      expect((await configure(loaded)).instructions).toBe("from the old setting");
      expect(loaded.getSettings).toHaveBeenCalledTimes(1);

      const fresh = await load({ stored: raw({ rules: [{ instructions: "stored" }] }), legacy: JSON.stringify([{ instructions: "changed later" }]) });
      expect(fresh.getSettings).not.toHaveBeenCalled();
      expect((await configure(fresh)).instructions).toBe("stored");
      expect(await fresh.kv.get("config")).toEqual(raw({ rules: [{ instructions: "stored" }] }));
    });

    it("does not import the old setting again at a restart, after a form save too", async () => {
      const first = await load({ legacy: JSON.stringify([{ instructions: "old" }]) });
      await save(first, raw({ rules: [{ instructions: "saved" }] }));
      const restarted = await first.harness.reload(first.create);
      await flush();
      expect(first.getSettings).toHaveBeenCalledTimes(1);
      expect(await restarted.bb.storage.kv.get("config")).toEqual(raw({ rules: [{ instructions: "saved" }] }));
    });
  });

  describe("the kept text (legacyRules)", () => {
    const text = "[{";
    const malformed = () => load({ legacy: text });

    it("is retried at every start until a config exists, and then kept until it is dismissed or imported over", async () => {
      const first = await malformed();
      expect(await first.kv.get("config")).toBeUndefined();
      const again = await first.harness.reload(first.create);
      await flush();
      expect(await again.bb.storage.kv.get("config")).toBeUndefined();
      expect(await again.bb.storage.kv.get("legacyRules")).toMatchObject({ text });
    });

    it("survives a form save, and the banner state keeps showing it", async () => {
      const loaded = await malformed();
      const after = await save(loaded, raw({ rules: [GUARD] }));
      expect(after.loadError).toMatchObject({ legacyText: text });
      expect(await loaded.kv.get("legacyRules")).toMatchObject({ text });
      expect((await state(loaded)).loadError).toMatchObject({ legacyText: text });
    });

    it("is deleted by a successful import, and the banner state follows", async () => {
      const loaded = await malformed();
      const file = path.join(base, "fixed.json");
      writeFileSync(file, JSON.stringify(raw({ rules: [GUARD] })));
      expect((await loaded.harness.runCli(["import", file])).exitCode).toBe(0);
      expect(await loaded.kv.get("legacyRules")).toBeUndefined();
      expect((await state(loaded)).loadError).toBeNull();
      expect((await loaded.harness.runCli(["export", "--legacy"])).exitCode).toBe(1);
    });

    it("is kept when the import is refused", async () => {
      const loaded = await malformed();
      const file = path.join(base, "bad.json");
      writeFileSync(file, JSON.stringify({ rules: [{ name: "r" }] }));
      expect((await loaded.harness.runCli(["import", file])).exitCode).toBe(1);
      expect(await loaded.kv.get("legacyRules")).toMatchObject({ text });
      expect((await state(loaded)).loadError).not.toBeNull();
    });

    it("is deleted by dismissLegacy, which returns the new state; a second dismissal is harmless", async () => {
      const loaded = await malformed();
      const after = (await loaded.harness.callRpc("dismissLegacy", null)) as ConfigState;
      expect(after.loadError).toBeNull();
      expect(await loaded.kv.get("legacyRules")).toBeUndefined();
      expect(((await loaded.harness.callRpc("dismissLegacy", null)) as ConfigState).loadError).toBeNull();
    });

    it("is read from storage at a start, so the banner returns after a restart until it is dismissed", async () => {
      const loaded = await load({ stored: raw({ rules: [GUARD] }), kept: { text: "old", error: "why" } });
      expect((await state(loaded)).loadError).toEqual({ message: "why", legacyText: "old" });
      expect(await loaded.harness.runCli(["export", "--legacy"])).toMatchObject({ exitCode: 0, stdout: "old" });
    });
  });
});

describe("one validation path for every writer", () => {
  it.each([
    ["a scope that carries claudeConfigDir", { scopes: [{ name: "w", paths: ["/w"], claudeConfigDir: "/home/me/.claude-w" }], rules: [GUARD] }, "claudeConfigDir"],
    ["a relative scope path", { scopes: [{ name: "w", paths: ["rel/dir"] }], rules: [GUARD] }, 'expected an absolute path or a path starting with "~/"'],
    ["an empty glob", { rules: [{ instructions: "x", project: [""] }] }, "project"],
    ["a control character in a name", { rules: [{ name: "bad\u0007name", instructions: "x" }] }, "control characters"],
    ["an unknown variable", { vars: { a: "A" }, rules: [{ instructions: "{{b}}" }] }, "rules[0]: unknown variable {{b}}"],
    ["an unknown key at the top", { rules: [], profiles: [] }, "Unrecognized key"],
    ["a value that is not an object", [{ instructions: "x" }], 'expected { "vars"?: {...}, "scopes"?: [...], "rules": [...] }'],
  ])("rejects %s through the RPC and stores nothing", async (_label, config, message) => {
    const loaded = await load({ stored: raw({ rules: [GUARD] }) });
    await expect(save(loaded, config)).rejects.toThrow(message);
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: [GUARD] }));
    expect((await state(loaded)).config).toEqual(raw({ rules: [GUARD] }));
  });

  it("rejects a vars.__proto__ key through the RPC, which must pass it on untouched to be able to", async () => {
    const loaded = await load();
    const config = JSON.parse('{"vars": {"__proto__": "x", "a": "y"}, "rules": []}');
    await expect(save(loaded, config)).rejects.toThrow('invalid variable name "__proto__" at vars');
    expect(await loaded.kv.get("config")).toBeUndefined();
  });

  it("stores what the form sent, normalized: nothing is lost from a saved glob and nothing empty is added", async () => {
    const loaded = await load();
    await save(loaded, {
      vars: { a: "A" },
      scopes: [{ name: "w", paths: ["/w", "~/x"] }],
      rules: [{ name: "r", scope: ["w", "w*"], skills: ["work-*", "other"], instructions: " {{a}} ", threads: "child" }],
    });
    expect(await loaded.kv.get("config")).toEqual({
      vars: { a: "A" },
      scopes: [{ name: "w", paths: ["/w", "~/x"] }],
      rules: [{ name: "r", scope: ["w", "w*"], skills: ["work-*", "other"], instructions: "{{a}}", threads: "child" }],
    });
  });

  it("returns the new state from a save, and logs the one line with the source", async () => {
    const loaded = await load();
    const after = await save(loaded, raw({ vars: { a: "A" }, scopes: [{ name: "w", paths: ["/w"] }], rules: [GUARD, { instructions: "{{a}}" }] }));
    expect(after.config.rules).toHaveLength(2);
    expect(logs(loaded, "info")).toContain("config saved from form: 2 rules, 1 scopes, 1 vars");
  });

  it("keeps a saved scope named like a profile scope ignored, and lists it", async () => {
    put(profilesPath(), { scopes: [{ name: "work", paths: ["/w"], claudeConfigDir: "~/.claude-work" }] });
    const loaded = await load();
    const after = await save(loaded, raw({ scopes: [{ name: "work", paths: ["/elsewhere"] }, { name: "plain", paths: ["/p"] }], rules: [{ scope: "work", instructions: "x" }] }));
    expect(after.ignoredScopes).toEqual(["work"]);
    expect(after.config.scopes.map((scope) => scope.name)).toEqual(["work", "plain"]);
    expect(after.profileScopes).toEqual([{ name: "work", paths: ["/w"] }]);
    // The profile scope's paths decide, not the saved scope's.
    expect((await configure(loaded, { path: "/w/app" })).instructions).toBe("x");
    expect((await configure(loaded, { path: "/elsewhere/app" })).instructions).toBeNull();
    expect(logs(loaded, "warn")).toContain('ignored saved scope "work": a profile scope with that name comes from profiles.json');
  });

  it("applies a save at once, before any restart", async () => {
    const loaded = await load();
    await save(loaded, raw({ rules: [{ instructions: "first" }] }));
    expect((await configure(loaded)).instructions).toBe("first");
    await save(loaded, raw({ rules: [{ instructions: "second" }] }));
    expect((await configure(loaded)).instructions).toBe("second");
  });

  it("stores nothing and changes nothing when the storage write fails, and the next write still runs", async () => {
    const loaded = await load({ stored: raw({ rules: [GUARD] }) });
    const realSet = loaded.host.bb.storage.kv.set.bind(loaded.host.bb.storage.kv);
    let fail = true;
    loaded.host.bb.storage.kv.set = async (key, value) => {
      if (fail) throw new Error("disk full");
      return realSet(key, value);
    };
    await expect(save(loaded, raw({ rules: [{ instructions: "lost" }] }))).rejects.toThrow("disk full");
    expect((await configure(loaded)).instructions).toBe("Guard.");
    expect((await state(loaded)).config).toEqual(raw({ rules: [GUARD] }));
    fail = false;
    await save(loaded, raw({ rules: [{ instructions: "kept" }] }));
    expect((await configure(loaded)).instructions).toBe("kept");
  });
});

describe("the RPC state for the settings form", () => {
  it("lists providers, projects, bundled skills without the always-injected one, cache state and over-budget types", async () => {
    const loaded = await load({ stored: raw({ rules: [{ instructions: x(3000) }, { instructions: x(3000) }] }) });
    // The stored text is over budget; the first refresh found that out.
    const current = await state(loaded);
    expect(current.providers).toEqual([{ id: "claude-code", models: ["opus"] }]);
    expect(current.projects).toEqual([{ id: "proj_1", name: "bb-plugins" }]);
    expect(current.skills).toEqual([
      { name: "other", description: "Fixture other" },
      { name: "work-conventions", description: "Fixture work-conventions" },
    ]);
    expect(current.cache).toEqual({ providers: { loaded: true, failed: false }, projects: { loaded: true, failed: false } });
    expect(current.overBudget.map((record) => [record.role, record.project]).sort()).toEqual([
      ["child", ""],
      ["child", "bb-plugins"],
      ["top-level", ""],
      ["top-level", "bb-plugins"],
    ]);
    expect(current.overBudget[0]).toEqual({
      provider: "claude-code",
      model: "opus",
      role: "top-level",
      project: "bb-plugins",
      length: 6002,
      rules: [0, 1],
      since: expect.any(String),
    });
    expect(current.loadError).toBeNull();
  });

  it("never carries a Claude config dir, however many profile scopes there are", async () => {
    mkdirSync(path.join(home, ".claude-work"), { recursive: true });
    put(profilesPath(), { scopes: [{ name: "work", paths: ["/w"], claudeConfigDir: "~/.claude-work" }] });
    const loaded = await load({ stored: raw({ scopes: [{ name: "saved", paths: ["/s"] }], rules: [GUARD] }) });
    const results = [
      await state(loaded),
      await save(loaded, raw({ scopes: [{ name: "saved", paths: ["/s"] }], rules: [GUARD] })),
      (await loaded.harness.callRpc("dismissLegacy", null)) as ConfigState,
    ];
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain("claudeConfigDir");
      expect(text).not.toContain(".claude-work");
      expect(result.profileScopes).toEqual([{ name: "work", paths: ["/w"] }]);
    }
  });

  it("shows the empty config when nothing is stored", async () => {
    expect((await state(await load())).config).toEqual({ vars: {}, scopes: [], rules: [] });
  });

  it("is registered, and not discoverable by agents", async () => {
    const loaded = await load();
    expect(loaded.harness.registrations.rpcMethods.sort()).toEqual(["dismissLegacy", "getState", "saveConfig"]);
    expect(loaded.harness.registrations.experimental_publishedRpcMethods).toEqual([]);
  });

  it("has a strict contract: an unknown key, a Claude config dir or a wrong type is not accepted in the output", () => {
    const valid: ConfigState = {
      config: { vars: {}, scopes: [], rules: [] },
      providers: [],
      projects: [],
      skills: [],
      profileScopes: [{ name: "w", paths: ["/w"] }],
      ignoredScopes: [],
      cache: { providers: { loaded: true, failed: false }, projects: { loaded: true, failed: false } },
      overBudget: [],
      loadError: null,
    };
    const { output } = modelInstructionsRpcContract.getState;
    expect(output.safeParse(valid).success).toBe(true);
    expect(output.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(output.safeParse({ ...valid, profileScopes: [{ name: "w", paths: [], claudeConfigDir: "/x" }] }).success).toBe(false);
    expect(output.safeParse({ ...valid, config: { ...valid.config, scopes: [{ name: "w", paths: [], claudeConfigDir: "/x" }] } }).success).toBe(false);
    expect(output.safeParse({ ...valid, cache: { providers: { loaded: true }, projects: valid.cache.projects } }).success).toBe(false);
    expect(output.safeParse({ ...valid, loadError: { message: "m" } }).success).toBe(false);
    expect(modelInstructionsRpcContract.saveConfig.input.safeParse({ config: {}, extra: 1 }).success).toBe(false);
    expect(modelInstructionsRpcContract.saveConfig.input.safeParse({}).success).toBe(false);
  });
});

describe("export and import", () => {
  it("round-trips unchanged: what export prints, import stores back as it was", async () => {
    const config = raw({
      vars: { gchat: "Chat." },
      scopes: [{ name: "w", paths: ["/w"] }],
      rules: [{ name: "r", scope: "w", skills: ["work-*"], skipTitles: "Help*", instructions: ["a {{gchat}}", "b"] }, { provider: "claude-code", skills: "other" }],
    });
    const loaded = await load({ stored: config });
    const exported = await loaded.harness.runCli(["export"]);
    expect(exported.exitCode).toBe(0);
    expect(JSON.parse(exported.stdout)).toEqual(config);
    const file = path.join(base, "backup.json");
    writeFileSync(file, exported.stdout);
    const other = await load();
    const result = await other.harness.runCli(["import", file]);
    expect(result).toMatchObject({ exitCode: 0, stdout: `imported ${file}: 2 rules, 1 scopes, 1 vars\n` });
    expect(await other.kv.get("config")).toEqual(config);
    expect((await other.harness.runCli(["export"])).stdout).toBe(exported.stdout);
    expect(logs(other, "info")).toContain("config saved from import: 2 rules, 1 scopes, 1 vars");
  });

  it("exports the empty config when nothing is stored, and that imports", async () => {
    const loaded = await load();
    const exported = await loaded.harness.runCli(["export"]);
    expect(JSON.parse(exported.stdout)).toEqual({ vars: {}, scopes: [], rules: [] });
    const file = path.join(base, "empty.json");
    writeFileSync(file, exported.stdout);
    expect((await loaded.harness.runCli(["import", file])).exitCode).toBe(0);
  });

  it("resolves a relative path against the CLI's working directory", async () => {
    const loaded = await load();
    writeFileSync(path.join(base, "rel.json"), JSON.stringify(raw({ rules: [GUARD] })));
    expect((await loaded.harness.runCli(["import", "rel.json"], { cwd: base })).exitCode).toBe(0);
    expect((await loaded.harness.runCli(["import", "rel.json"])).exitCode).toBe(2);
    expect((await configure(loaded)).instructions).toBe("Guard.");
  });

  it("replaces the whole config with the file's, last writer wins", async () => {
    const loaded = await load({ stored: raw({ vars: { a: "A" }, rules: [{ instructions: "{{a}} old" }] }) });
    const file = path.join(base, "new.json");
    writeFileSync(file, JSON.stringify(raw({ rules: [{ instructions: "new" }] })));
    await loaded.harness.runCli(["import", file]);
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: [{ instructions: "new" }] }));
  });
});

describe("the write queue", () => {
  const DIR_SKILLS_EXPORT = { uiScopes: [{ name: "acme", paths: ["/srv/acme"], skills: ["work-*"] }], pins: [] };

  /** A host whose first write to the config blocks until `release()`, so a race can be set up in order. */
  async function gated(stored: unknown) {
    put(path.join(home, ".bb", "dir-skills", "export.json"), DIR_SKILLS_EXPORT);
    const loaded = await load({ stored });
    const realSet = loaded.host.bb.storage.kv.set.bind(loaded.host.bb.storage.kv);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    loaded.host.bb.storage.kv.set = async (key, value) => {
      if (key === "config" && first) {
        first = false;
        await gate;
      }
      return realSet(key, value);
    };
    return { loaded, release };
  }

  it("import-dir-skills run second sees the form's save: the final config holds both", async () => {
    const { loaded, release } = await gated(raw({ rules: [GUARD] }));
    const formSave = save(loaded, raw({ vars: { a: "A" }, rules: [GUARD, { name: "from-form", instructions: "{{a}}" }] }));
    await flush();
    const importing = loaded.harness.runCli(["import-dir-skills"]);
    await flush();
    release();
    expect((await importing).exitCode).toBe(0);
    await formSave;
    expect(await loaded.kv.get("config")).toEqual({
      vars: { a: "A" },
      scopes: [{ name: "acme", paths: ["/srv/acme"] }],
      rules: [
        { ...GUARD, threads: "any" },
        { name: "from-form", instructions: "{{a}}", threads: "any" },
        { name: "dir-skills:acme", scope: ["acme"], skills: ["work-*"], threads: "any" },
      ],
    });
    expect(logs(loaded, "info").filter((line) => line.startsWith("config saved from"))).toEqual([
      "config saved from form: 2 rules, 0 scopes, 1 vars",
      "config saved from import-dir-skills: 3 rules, 1 scopes, 1 vars",
    ]);
  });

  it("a form save run second is a full replace of what the form held: last writer wins", async () => {
    const { loaded, release } = await gated(raw({ rules: [GUARD] }));
    const importing = loaded.harness.runCli(["import-dir-skills"]);
    await flush();
    const formSave = save(loaded, raw({ rules: [GUARD, { name: "from-form", instructions: "x" }] }));
    await flush();
    release();
    expect((await importing).exitCode).toBe(0);
    await formSave;
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: [GUARD, { name: "from-form", instructions: "x" }] }));
    expect(logs(loaded, "info").filter((line) => line.startsWith("config saved from")).map((line) => line.split(":")[0])).toEqual([
      "config saved from import-dir-skills",
      "config saved from form",
    ]);
  });

  it("serializes every writer: a refused write does not stop the next", async () => {
    const { loaded, release } = await gated(undefined);
    const first = save(loaded, raw({ rules: [{ instructions: "one" }] }));
    await flush();
    const refused = save(loaded, { rules: [{ name: "r" }] });
    const refusedResult = expect(refused).rejects.toThrow('a rule needs "instructions", "skills", or both');
    const third = save(loaded, raw({ rules: [{ instructions: "three" }] }));
    await flush();
    expect(await loaded.kv.get("config")).toBeUndefined();
    release();
    await first;
    await refusedResult;
    await third;
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: [{ instructions: "three" }] }));
  });

  it("import-dir-skills writes the config through the queue, validating against the profile scopes it just wrote", async () => {
    mkdirSync(path.join(home, ".claude-acme"), { recursive: true });
    put(path.join(home, ".bb", "dir-skills", "scopes.json"), {
      scopes: [{ name: "prof", paths: ["/srv/prof"], skills: ["work-*"], claudeConfigDir: "~/.claude-acme" }],
    });
    put(path.join(home, ".bb", "dir-skills", "export.json"), { uiScopes: [], pins: [] });
    const loaded = await load({ stored: raw({ rules: [GUARD] }) });
    const result = await loaded.harness.runCli(["import-dir-skills"]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(profilesPath())).toBe(true);
    // The new rule names the profile scope: it resolves only because the profiles were reloaded first.
    expect(await loaded.kv.get("config")).toEqual(
      raw({ rules: [GUARD, { name: "dir-skills:prof", scope: ["prof"], skills: ["work-*"] }] }),
    );
    expect(JSON.parse(readFileSync(profilesPath(), "utf8")).scopes[0]).toMatchObject({ name: "prof" });
    expect((await state(loaded)).profileScopes).toEqual([{ name: "prof", paths: ["/srv/prof"] }]);
    expect(logs(loaded, "info")).toContain("config saved from import-dir-skills: 2 rules, 0 scopes, 0 vars");
  });
});
