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
  /** Runs on the host's storage before the plugin starts, to make a call fail. */
  prepare?: (kv: ReturnType<typeof createFakePluginHost>["bb"]["storage"]["kv"]) => void;
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
  options.prepare?.(host.bb.storage.kv);
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
      loadError: { kind: "legacy", message: record.error, legacyText: text },
    });
    expect(await loaded.harness.runCli(["export", "--legacy"])).toMatchObject({ exitCode: 0, stdout: text + "\n" });
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
    expect(await state(loaded)).toMatchObject({ loadError: { kind: "legacy", message: expect.stringContaining(message), legacyText: text } });
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

  describe("when the old setting cannot be read", () => {
    const MESSAGE =
      "the old rules setting could not be read: host down. Restart bb or reload the plugin before you save here: once this form saves, the old setting is no longer imported.";
    const down = { plugins: { getSettings: async () => { throw new Error("host down"); } } };

    it("warns with the reason, keeps it in memory only, and shows it with no old text", async () => {
      const loaded = await load({ sdk: down });
      expect(await loaded.kv.get("config")).toBeUndefined();
      expect(await loaded.kv.get("legacyRules")).toBeUndefined();
      expect(logs(loaded, "warn")).toEqual([MESSAGE]);
      expect(logs(loaded, "debug")).not.toContain(MESSAGE);
      expect((await state(loaded)).loadError).toEqual({ kind: "legacy", message: MESSAGE, legacyText: "" });
    });

    it("says nothing about the old setting when the host has no plugin settings call at all", async () => {
      const loaded = await load();
      expect(await loaded.kv.get("config")).toBeUndefined();
      expect(logs(loaded, "warn")).toEqual([expect.stringContaining("the old rules setting could not be read: ")]);
    });

    it("is not kept across a restart: the import is tried again, and a good read leaves no error", async () => {
      let broken = true;
      const getSettings = vi.fn(async () => {
        if (broken) throw new Error("host down");
        return { values: { rules: JSON.stringify([GUARD]) } };
      });
      const first = await load({ sdk: { plugins: { getSettings } } });
      expect((await state(first)).loadError).toEqual({ kind: "legacy", message: MESSAGE, legacyText: "" });
      broken = false;
      const restarted = await first.harness.reload(first.create);
      await flush();
      expect(getSettings).toHaveBeenCalledTimes(2);
      expect(await restarted.bb.storage.kv.get("config")).toEqual(raw({ rules: [GUARD] }));
      expect(((await restarted.harness.callRpc("getState", null)) as ConfigState).loadError).toBeNull();
    });

    it("loses to a kept old text", async () => {
      const loaded = await load({ sdk: down, kept: { text: "old", error: "why" } });
      expect((await state(loaded)).loadError).toEqual({ kind: "legacy", message: "why", legacyText: "old" });
    });

    it("is cleared by a successful form save", async () => {
      const loaded = await load({ sdk: down });
      expect((await save(loaded, raw({ rules: [GUARD] }))).loadError).toBeNull();
      expect((await state(loaded)).loadError).toBeNull();
    });

    it("is kept when the form save is refused", async () => {
      const loaded = await load({ sdk: down });
      await expect(save(loaded, { rules: [{ name: "r" }] })).rejects.toThrow();
      expect((await state(loaded)).loadError).toEqual({ kind: "legacy", message: MESSAGE, legacyText: "" });
    });

    it("is cleared by a successful import-dir-skills", async () => {
      put(path.join(home, ".bb", "dir-skills", "scopes.json"), { scopes: [{ name: "prof", paths: ["/srv/prof"], skills: ["work-*"] }] });
      put(path.join(home, ".bb", "dir-skills", "export.json"), { uiScopes: [], pins: [] });
      const loaded = await load({ sdk: down });
      expect((await loaded.harness.runCli(["import-dir-skills"])).exitCode).toBe(0);
      expect(logs(loaded, "info")).toContain("config saved from import-dir-skills: 1 rules, 1 scopes, 0 vars");
      expect((await state(loaded)).loadError).toBeNull();
    });

    it("is cleared by a successful import", async () => {
      const loaded = await load({ sdk: down });
      const file = path.join(base, "fixed.json");
      writeFileSync(file, JSON.stringify(raw({ rules: [GUARD] })));
      expect((await loaded.harness.runCli(["import", file])).exitCode).toBe(0);
      expect((await state(loaded)).loadError).toBeNull();
    });
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
      expect((await state(loaded)).loadError).toEqual({ kind: "legacy", message: "why", legacyText: "old" });
      expect(await loaded.harness.runCli(["export", "--legacy"])).toMatchObject({ exitCode: 0, stdout: "old\n" });
    });
  });
});

/** Makes one kv method throw for one key, and leaves every other call alone. */
function failing(method: "get" | "set" | "delete", key: string, message = "disk full") {
  return (kv: ReturnType<typeof createFakePluginHost>["bb"]["storage"]["kv"]) => {
    const original = kv[method].bind(kv) as (key: string, value?: unknown) => Promise<unknown>;
    vi.spyOn(kv, method).mockImplementation((async (at: string, value?: unknown) => {
      if (at === key) throw new Error(message);
      return original(at, value);
    }) as never);
  };
}

describe("a kv failure never fails the start (legacy import)", () => {
  const OLD = JSON.stringify([GUARD]);
  const SAVE_MESSAGE =
    "the old rules setting could not be saved: disk full. Restart bb or reload the plugin before you save here: once this form saves, the old setting is no longer imported.";

  it("clears the save-failure banner by a successful form save", async () => {
    const loaded = await load({ legacy: OLD, prepare: failing("set", "config") });
    expect((await state(loaded)).loadError).toMatchObject({ kind: "legacy", message: SAVE_MESSAGE });
    vi.restoreAllMocks();
    expect((await save(loaded, raw({ rules: [GUARD] }))).loadError).toBeNull();
    expect((await state(loaded)).loadError).toBeNull();
  });

  it("shows no banner when the write works", async () => {
    const loaded = await load({ legacy: OLD });
    expect((await state(loaded)).loadError).toBeNull();
  });

  it("logs a failed write of the imported config, runs with no rules, keeps no old text, and imports again at the next start", async () => {
    const loaded = await load({ legacy: OLD, prepare: failing("set", "config") });
    expect(logs(loaded, "warn")).toContain(
      "the old rules setting could not be saved: disk full; it is imported again at the next start",
    );
    expect(await loaded.kv.get("config")).toBeUndefined();
    expect(await loaded.kv.get("legacyRules")).toBeUndefined();
    expect((await state(loaded)).loadError).toEqual({ kind: "legacy", message: SAVE_MESSAGE, legacyText: "" });
    expect((await configure(loaded)).instructions).toBeNull();
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    expect(await restarted.bb.storage.kv.get("config")).toEqual(raw({ rules: [GUARD] }));
  });

  it("is not a parse error: a good setting is not kept as old text when the write fails", async () => {
    const loaded = await load({ legacy: OLD, prepare: failing("set", "config") });
    expect(logs(loaded, "warn").some((line) => line.startsWith("the old rules setting was not imported"))).toBe(false);
    expect((await loaded.harness.runCli(["export", "--legacy"])).exitCode).toBe(1);
  });

  it("logs a failed save of the kept old text, and keeps the record in memory for this run", async () => {
    const text = "[{";
    const loaded = await load({ legacy: text, prepare: failing("set", "legacyRules") });
    expect(logs(loaded, "warn")).toContain("the old rules setting could not be kept: disk full");
    expect(await loaded.kv.get("legacyRules")).toBeUndefined();
    expect((await state(loaded)).loadError).toMatchObject({ kind: "legacy", legacyText: text });
    expect(await loaded.harness.runCli(["export", "--legacy"])).toMatchObject({ exitCode: 0, stdout: text + "\n" });
  });
});

describe("dismissing the kept old text lasts", () => {
  const text = "[{";

  it("stores the flag, and the banner stays away after a restart", async () => {
    const loaded = await load({ legacy: text });
    expect((await state(loaded)).loadError).not.toBeNull();
    expect(((await loaded.harness.callRpc("dismissLegacy", null)) as ConfigState).loadError).toBeNull();
    expect(await loaded.kv.get("legacyDismissed")).toBe(true);
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    expect(((await restarted.harness.callRpc("getState", null)) as ConfigState).loadError).toBeNull();
    expect(await restarted.bb.storage.kv.get("legacyRules")).toBeUndefined();
    expect(restarted.harness.logEntries.filter((entry) => entry.level === "debug").map((entry) => entry.message)).toContain(
      "the old rules setting was dismissed; not importing it",
    );
    expect(loaded.getSettings).toHaveBeenCalledTimes(1);
  });

  it("without a dismissal the banner returns after a restart", async () => {
    const loaded = await load({ legacy: text });
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    expect(((await restarted.harness.callRpc("getState", null)) as ConfigState).loadError).toMatchObject({ kind: "legacy", legacyText: text });
    expect(await restarted.bb.storage.kv.get("legacyDismissed")).toBeUndefined();
  });

  it("is not changed by a successful import", async () => {
    const loaded = await load({ legacy: text });
    await loaded.harness.callRpc("dismissLegacy", null);
    const file = path.join(base, "fixed.json");
    writeFileSync(file, JSON.stringify(raw({ rules: [GUARD] })));
    expect((await loaded.harness.runCli(["import", file])).exitCode).toBe(0);
    expect(await loaded.kv.get("legacyDismissed")).toBe(true);
  });
});

describe("the stored old text is validated", () => {
  it.each([
    ["a text that is not a string", { text: 5, error: "why" }],
    ["a missing error", { text: "old" }],
    ["an extra key", { text: "old", error: "why", more: 1 }],
    ["a value that is not an object", "old"],
  ])("ignores and deletes %s", async (_label, kept) => {
    const loaded = await load({ stored: raw({ rules: [GUARD] }), kept });
    expect(logs(loaded, "warn")).toContain("stored old setting text ignored: wrong shape");
    expect(await loaded.kv.get("legacyRules")).toBeUndefined();
    expect((await state(loaded)).loadError).toBeNull();
    expect((await loaded.harness.runCli(["export", "--legacy"])).exitCode).toBe(1);
  });

  it("does not warn for a record of the right shape", async () => {
    const loaded = await load({ stored: raw({ rules: [GUARD] }), kept: { text: "old", error: "why" } });
    expect(logs(loaded, "warn")).toEqual([]);
    expect(await loaded.kv.get("legacyRules")).toEqual({ text: "old", error: "why" });
  });
});

describe("an import whose cleanup fails", () => {
  it("still succeeds with the normal output, and warns", async () => {
    const loaded = await load({ legacy: "[{", prepare: failing("delete", "legacyRules") });
    const file = path.join(base, "fixed.json");
    writeFileSync(file, JSON.stringify(raw({ rules: [GUARD] })));
    expect(await loaded.harness.runCli(["import", file])).toMatchObject({
      exitCode: 0,
      stdout: `imported ${file}: 1 rules, 0 scopes, 0 vars\n`,
    });
    expect(logs(loaded, "warn")).toContain("the kept old setting text could not be removed: disk full");
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: [GUARD] }));
  });

  it("leaves no stale banner, and says so on stderr", async () => {
    const loaded = await load({ legacy: "[{", prepare: failing("delete", "legacyRules") });
    expect((await state(loaded)).loadError).toMatchObject({ kind: "legacy", legacyText: "[{" });
    const file = path.join(base, "fixed-stale.json");
    writeFileSync(file, JSON.stringify(raw({ rules: [GUARD] })));
    const result = await loaded.harness.runCli(["import", file]);
    expect(result).toMatchObject({
      exitCode: 0,
      stderr: "import: the kept old setting text could not be removed: disk full\n",
    });
    expect((await state(loaded)).loadError).toBeNull();
    expect((await loaded.harness.runCli(["export", "--legacy"])).exitCode).toBe(1);
  });

  it("prints nothing on stderr when the cleanup works", async () => {
    const loaded = await load({ legacy: "[{" });
    const file = path.join(base, "fixed-clean.json");
    writeFileSync(file, JSON.stringify(raw({ rules: [GUARD] })));
    const result = await loaded.harness.runCli(["import", file]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr ?? "").toBe("");
    expect((await state(loaded)).loadError).toBeNull();
  });
});

describe("dismissing with no kept old text", () => {
  it("changes nothing: no flag is stored, and the state comes back", async () => {
    const loaded = await load({ stored: raw({ rules: [GUARD] }) });
    const result = (await loaded.harness.callRpc("dismissLegacy", null)) as ConfigState;
    expect(result).toEqual(await state(loaded));
    expect(result.loadError).toBeNull();
    expect(await loaded.kv.get("legacyDismissed")).toBeUndefined();
  });

  it("sets the flag when old text is kept", async () => {
    const loaded = await load({ legacy: "[{" });
    await loaded.harness.callRpc("dismissLegacy", null);
    expect(await loaded.kv.get("legacyDismissed")).toBe(true);
  });
});

describe("a failed read of the plugin's storage at start", () => {
  const READ = (key: string) =>
    `the plugin's storage could not be read: disk gone ${key}`;
  const MESSAGE = (key: string) => `${READ(key)}. Reload the plugin (bb plugin reload model-instructions) before saving.`;
  const REFUSAL =
    "the plugin's storage could not be read at start; reload the plugin (bb plugin reload model-instructions) before saving";
  // Fails the start-path read of one key only; the test's own reads afterwards go through.
  const readFails = (key: string) => (kv: ReturnType<typeof createFakePluginHost>["bb"]["storage"]["kv"]) => {
    const original = kv.get.bind(kv) as (key: string) => Promise<unknown>;
    let failed = false;
    vi.spyOn(kv, "get").mockImplementation((async (at: string) => {
      if (at === key && !failed) {
        failed = true;
        throw new Error(`disk gone ${key}`);
      }
      return original(at);
    }) as never);
  };

  it.each(["config", "legacyRules", "legacyDismissed"])(
    "(%s) still registers configure, RPC and CLI, warns, runs with no rules and shows the storage banner",
    async (key) => {
      const loaded = await load({ legacy: JSON.stringify([GUARD]), prepare: readFails(key) });
      expect(logs(loaded, "warn")).toContain(READ(key));
      expect((await state(loaded)).loadError).toEqual({ kind: "storage", message: MESSAGE(key), legacyText: "" });
      expect((await configure(loaded)).instructions).toBeNull();
      const status = await loaded.harness.runCli(["status"]);
      expect(status.exitCode).toBe(0);
    },
  );

  it("does not run the legacy import when a read failed", async () => {
    const loaded = await load({ legacy: JSON.stringify([GUARD]), prepare: readFails("legacyDismissed") });
    expect(loaded.getSettings).not.toHaveBeenCalled();
    expect(await loaded.kv.get("config")).toBeUndefined();
  });

  it("does not adopt a stored config when the kept-text read failed", async () => {
    const loaded = await load({ stored: raw({ rules: [GUARD] }), prepare: readFails("legacyRules") });
    expect((await configure(loaded)).instructions).toBeNull();
  });

  it("beats a stored-config error and a kept old text in the banner", async () => {
    const loaded = await load({ kept: { text: "old", error: "why" }, prepare: readFails("config") });
    expect((await state(loaded)).loadError).toMatchObject({ kind: "storage" });
  });

  it("refuses the form save, writing nothing", async () => {
    const loaded = await load({ prepare: readFails("config") });
    await expect(save(loaded, raw({ rules: [GUARD] }))).rejects.toThrow(REFUSAL);
    expect(await loaded.kv.get("config")).toBeUndefined();
    expect((await state(loaded)).loadError).toMatchObject({ kind: "storage" });
  });

  it("refuses import, writing nothing", async () => {
    const loaded = await load({ prepare: readFails("config") });
    const file = path.join(base, "refused.json");
    writeFileSync(file, JSON.stringify(raw({ rules: [GUARD] })));
    expect(await loaded.harness.runCli(["import", file])).toMatchObject({ exitCode: 1, stderr: `import: ${REFUSAL}\n` });
    expect(await loaded.kv.get("config")).toBeUndefined();
  });

  it("refuses import-dir-skills with exit 1, writing nothing", async () => {
    put(path.join(home, ".bb", "dir-skills", "scopes.json"), { scopes: [{ name: "prof", paths: ["/srv/prof"], skills: ["work-*"] }] });
    put(path.join(home, ".bb", "dir-skills", "export.json"), { uiScopes: [], pins: [] });
    const loaded = await load({ prepare: readFails("config") });
    expect(await loaded.harness.runCli(["import-dir-skills"])).toMatchObject({
      exitCode: 1,
      stderr: `import-dir-skills: ${REFUSAL}\n`,
    });
    expect(await loaded.kv.get("config")).toBeUndefined();
  });

  it("refuses dismissLegacy too", async () => {
    const loaded = await load({ prepare: readFails("config") });
    await expect(loaded.harness.callRpc("dismissLegacy", null)).rejects.toThrow(REFUSAL);
    expect(await loaded.kv.get("legacyDismissed")).toBeUndefined();
  });

  it("is normal without the failure: no banner, saves work", async () => {
    const loaded = await load({ legacy: "[]" });
    expect((await state(loaded)).loadError).toBeNull();
    expect((await save(loaded, raw({ rules: [GUARD] }))).loadError).toBeNull();
  });
});

describe("a failed delete of a wrong-shape kept text", () => {
  it("warns and starts normally", async () => {
    const loaded = await load({
      kept: { text: 1 },
      stored: raw({ rules: [GUARD] }),
      prepare: failing("delete", "legacyRules"),
    });
    expect(logs(loaded, "warn")).toContain("stored old setting text could not be removed: disk full");
    expect((await state(loaded)).loadError).toBeNull();
    expect((await configure(loaded)).instructions).toContain("Guard.");
  });
});

describe("a stored config that fails to load", () => {
  const BAD = { rules: [{ name: "r" }] };
  const PREFIX = "the saved config could not be loaded: ";
  const IMPORT_DIR_SKILLS_REFUSAL =
    "import-dir-skills: the saved config could not be loaded, so nothing is merged into it; fix it with bb model-instructions import <file> first\n";

  it("keeps running with no rules, and shows the message and the stored value in the banner state", async () => {
    const loaded = await load({ stored: BAD });
    const current = await state(loaded);
    expect(current.config).toEqual({ vars: {}, scopes: [], rules: [] });
    expect(current.loadError).toEqual({
      kind: "stored",
      message: expect.stringMatching(new RegExp(`^${PREFIX}.+`, "s")),
      legacyText: JSON.stringify(BAD, null, 2),
    });
    expect((await configure(loaded)).instructions).toBeNull();
    expect(await loaded.kv.get("config")).toEqual(BAD);
  });

  it("has an empty text when the stored value has no JSON text", async () => {
    const loaded = await load({ prepare: (kv) => void vi.spyOn(kv, "get").mockImplementation((async (key: string) => (key === "config" ? { rules: 1n } : undefined)) as never) });
    expect((await state(loaded)).loadError).toEqual({ kind: "stored", message: expect.stringContaining(PREFIX), legacyText: "" });
  });

  it("wins over a kept old text and a read error", async () => {
    const kept = await load({ stored: BAD, kept: { text: "old", error: "why" } });
    expect((await state(kept)).loadError).toMatchObject({ kind: "stored" });
    expect(await kept.harness.runCli(["export", "--legacy"])).toMatchObject({ exitCode: 0, stdout: "old\n" });
  });

  it("does not show up for a stored config that loads", async () => {
    const loaded = await load({ stored: raw({ rules: [GUARD] }) });
    expect((await state(loaded)).loadError).toBeNull();
    expect(await loaded.harness.runCli(["export"])).toMatchObject({ stdout: JSON.stringify(raw({ rules: [GUARD] }), null, 2) + "\n" });
  });

  it("is printed as stored by export, not as the empty config", async () => {
    const loaded = await load({ stored: BAD });
    expect(await loaded.harness.runCli(["export"])).toMatchObject({
      exitCode: 0,
      stdout: JSON.stringify(BAD, null, 2) + "\n",
      stderr: "export: the saved config could not be loaded; this is the stored value, not the active config\n",
    });
  });

  it("makes import-dir-skills refuse, for a dry run too, and write nothing", async () => {
    put(path.join(home, ".bb", "dir-skills", "scopes.json"), { scopes: [{ name: "prof", paths: ["/srv/prof"], skills: ["work-*"] }] });
    put(path.join(home, ".bb", "dir-skills", "export.json"), { uiScopes: [], pins: [] });
    const loaded = await load({ stored: BAD });
    for (const args of [["import-dir-skills"], ["import-dir-skills", "--dry-run"]])
      expect(await loaded.harness.runCli(args)).toMatchObject({ exitCode: 1, stderr: IMPORT_DIR_SKILLS_REFUSAL });
    expect(await loaded.kv.get("config")).toEqual(BAD);
    expect(existsSync(profilesPath())).toBe(false);
    expect((await state(loaded)).loadError).toMatchObject({ kind: "stored" });
  });

  it("is kept when a form save or an import is refused", async () => {
    const loaded = await load({ stored: BAD });
    await expect(save(loaded, { rules: [{ name: "r" }] })).rejects.toThrow();
    const file = path.join(base, "bad.json");
    writeFileSync(file, JSON.stringify(BAD));
    expect((await loaded.harness.runCli(["import", file])).exitCode).toBe(1);
    expect((await state(loaded)).loadError).toMatchObject({ kind: "stored" });
    expect(await loaded.kv.get("config")).toEqual(BAD);
  });

  it("is cleared by a successful import, and import-dir-skills then works", async () => {
    put(path.join(home, ".bb", "dir-skills", "scopes.json"), { scopes: [{ name: "prof", paths: ["/srv/prof"], skills: ["work-*"] }] });
    put(path.join(home, ".bb", "dir-skills", "export.json"), { uiScopes: [], pins: [] });
    const loaded = await load({ stored: BAD });
    const file = path.join(base, "fixed.json");
    writeFileSync(file, JSON.stringify(raw({ rules: [GUARD] })));
    expect((await loaded.harness.runCli(["import", file])).exitCode).toBe(0);
    expect((await state(loaded)).loadError).toBeNull();
    expect((await loaded.harness.runCli(["export"])).stdout).toBe(JSON.stringify(raw({ rules: [GUARD] }), null, 2) + "\n");
    expect((await loaded.harness.runCli(["import-dir-skills"])).exitCode).toBe(0);
  });

  it("is cleared by a successful form save", async () => {
    const loaded = await load({ stored: BAD });
    expect((await save(loaded, raw({ rules: [GUARD] }))).loadError).toBeNull();
    expect((await state(loaded)).loadError).toBeNull();
    expect((await loaded.harness.runCli(["export"])).stdout).toBe(JSON.stringify(raw({ rules: [GUARD] }), null, 2) + "\n");
  });

  it("is not carried to a restart that finds a config that loads", async () => {
    const loaded = await load({ stored: BAD });
    await save(loaded, raw({ rules: [GUARD] }));
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    expect(((await restarted.harness.callRpc("getState", null)) as ConfigState).loadError).toBeNull();
  });

  it("is not touched by dismissLegacy", async () => {
    const loaded = await load({ stored: BAD, kept: { text: "old", error: "why" } });
    expect(((await loaded.harness.callRpc("dismissLegacy", null)) as ConfigState).loadError).toMatchObject({ kind: "stored" });
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
