import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelInstructionsRpcContract, type ConfigState } from "./rpc-contract.js";
import { parseLegacyText, parseRawConfig } from "./src/rules.js";

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

interface RulesHandle {
  get(): Promise<{ rules: string }>;
  experimental_set(values: { rules: string | null }): Promise<unknown>;
  onChange(listener: (next: unknown, prev: unknown) => void): void;
}

interface Options {
  /** The value of the setting of the previous versions, as bb has it stored. */
  rules?: string;
  /** Stored under kv `previousSettingDone` before the plugin starts. */
  done?: boolean;
  /** Stored under kv `config` before the plugin starts. */
  stored?: unknown;
  /** Stored under kv `legacyRules` before the plugin starts: what v0.1.12 kept. */
  v012Rules?: unknown;
  /** Stored under kv `legacyDismissed` before the plugin starts: what v0.1.12 kept. */
  v012Dismissed?: boolean;
  sdk?: Record<string, unknown>;
  /** Runs on the host's storage before the plugin starts, to make a call fail. */
  prepare?: (kv: ReturnType<typeof createFakePluginHost>["bb"]["storage"]["kv"]) => void;
  /** Wraps the handle the plugin gets for its setting, to make a call fail or to count calls. */
  setting?: (handle: RulesHandle) => RulesHandle;
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
  const getSettings = vi.fn(async () => ({ values: {} }));
  const host = createFakePluginHost({
    pluginId: "model-instructions",
    agentSkillIds: ["model-instructions", ...SKILLS],
    ...(options.rules === undefined ? {} : { settings: { rules: options.rules } }),
    sdk: { ...worldSdk(options.sdk), plugins: { getSettings } },
  });
  // The handles bb gives the plugin for its setting, as they are before any wrapper.
  const handles: RulesHandle[] = [];
  const define = host.bb.settings.define.bind(host.bb.settings) as (descriptors: unknown) => RulesHandle;
  vi.spyOn(host.bb.settings, "define").mockImplementation(((descriptors: unknown) => {
    const handle = define(descriptors);
    handles.push(handle);
    return options.setting?.(handle) ?? handle;
  }) as never);
  if (options.stored !== undefined) await host.bb.storage.kv.set("config", options.stored);
  if (options.done !== undefined) await host.bb.storage.kv.set("previousSettingDone", options.done);
  if (options.v012Rules !== undefined) await host.bb.storage.kv.set("legacyRules", options.v012Rules);
  if (options.v012Dismissed !== undefined) await host.bb.storage.kv.set("legacyDismissed", options.v012Dismissed);
  options.prepare?.(host.bb.storage.kv);
  const create = await pluginAt();
  await create(host.bb);
  await flush();
  /** The value of the setting right now; undefined while it is not declared. */
  const rules = async () => (handles.length === 0 ? undefined : (await handles[0].get()).rules);
  return { host, harness: host.harness, kv: host.bb.storage.kv, getSettings, create, rules };
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

const SERVICE = "previous-setting";
const serviceNames = (loaded: Loaded) => loaded.harness.registrations.services.map((service) => service.name);
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const backupDir = () => path.join(home, ".bb", "model-instructions", "backups");
const backupFiles = () => (existsSync(backupDir()) ? readdirSync(backupDir()) : []);
const backupPath = (index = 0) => path.join(backupDir(), backupFiles().sort()[index]);

/** Starts the background service the way bb does once the factory is done, and waits until its work is finished. */
async function runMigration(loaded: Loaded) {
  const run = loaded.harness.runService(SERVICE);
  await settle();
  return run;
}

/** Ends a run the way bb does on dispose: abort, and the service resolves. */
async function endRun(run: Awaited<ReturnType<typeof runMigration>>): Promise<void> {
  run.controller.abort();
  await run.done;
}

const OLD_RULE = { name: "old", instructions: "From the previous version." };
const OLD = JSON.stringify([OLD_RULE]);
const BAD_OLD = '[{"instructions": "{{nope}}"}]';
const parseReason = (text: string) => {
  try {
    parseLegacyText(text);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the text not to parse");
};
const MOVED = (file: string) => `rules from the previous version moved: backup ${file}`;
const ALREADY_SAVED = (file: string) => `rules from the previous version already saved; backup ${file}`;
const NOT_EMPTIED = (reason: string) =>
  `the setting with the rules from the previous version could not be emptied: ${reason}; it is tried again at the next start`;
const BACKUP_FAILED = (reason: string) =>
  `could not back up the rules from the previous version: ${reason}; nothing was changed, it is tried again at the next start`;
const MOVE_FAILED = (reason: string) =>
  `the rules from the previous version could not be moved: ${reason}; it is tried again at the next start`;
const CONFLICT = (file: string) =>
  `A copy of the previous rules is in ${file}. To replace the rules saved here with them, run bb model-instructions import ${file}; to keep the rules saved here, press Keep the rules saved here.`;

function importFile(name: string, content: unknown): string {
  const file = path.join(base, name);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

/** Counts the calls on the setting handle, and the order of the plugin's first calls on its host. */
function spied() {
  const get = vi.fn();
  const set = vi.fn();
  const wrap = (handle: RulesHandle): RulesHandle => ({
    ...handle,
    get: () => {
      get();
      return handle.get();
    },
    experimental_set: (values) => {
      set(values);
      return handle.experimental_set(values);
    },
  });
  return { get, set, wrap };
}

describe("the setting of the previous versions: declared until it is moved", () => {
  it("is declared with its label, description, multiline box and empty default while the flag is absent, with its service", async () => {
    const loaded = await load();
    expect(loaded.harness.registrations.settingsDescriptors).toEqual({
      rules: expect.objectContaining({
        type: "string",
        label: "Rules (previous versions)",
        description:
          "Moved into the form below automatically, then removed. If the form shows a banner about it, the move is waiting for you. A copy is kept in ~/.bb/model-instructions/backups/. Edits here are not read after the move.",
        experimental_multiline: true,
        default: "",
      }),
    });
    expect(loaded.harness.registrations.settingsDescriptors.rules).not.toHaveProperty("schema");
    expect(serviceNames(loaded)).toContain(SERVICE);
  });

  it("is not declared, and has no service, once the flag is set", async () => {
    const loaded = await load({ done: true, rules: OLD });
    expect(loaded.harness.registrations.settingsDescriptors).toEqual({});
    expect(serviceNames(loaded)).not.toContain(SERVICE);
    expect(loaded.getSettings).not.toHaveBeenCalled();
  });

  it("is not declared again after the move, at the next start", async () => {
    const loaded = await load({ rules: OLD });
    await endRun(await runMigration(loaded));
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    expect(restarted.harness.registrations.settingsDescriptors).toEqual({});
    expect(serviceNames(restarted)).not.toContain(SERVICE);
    expect(((await restarted.harness.callRpc("getState", null)) as ConfigState).loadError).toBeNull();
    expect((await configure(restarted)).instructions).toBe("From the previous version.");
  });

  it("saves from the form, import and import-dir-skills as before once the flag is set", async () => {
    const loaded = await load({ done: true });
    expect((await save(loaded, raw({ rules: [GUARD] }))).loadError).toBeNull();
    const file = importFile("after.json", raw({ rules: [OLD_RULE] }));
    expect((await loaded.harness.runCli(["import", file])).exitCode).toBe(0);
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: [OLD_RULE] }));
  });
});

describe("the move: nothing to move (step a)", () => {
  it.each([
    ["an empty value", ""],
    ["a blank value", " \n\t "],
  ])("sets the flag for %s, makes no backup and does not touch the setting", async (_label, text) => {
    const probe = spied();
    const loaded = await load({ rules: text, setting: probe.wrap });
    await endRun(await runMigration(loaded));
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(probe.set).not.toHaveBeenCalled();
    expect(backupFiles()).toEqual([]);
    expect(existsSync(backupDir())).toBe(false);
    expect(logs(loaded, "debug")).toContain("no rules from the previous version to move");
    expect(await loaded.kv.get("config")).toBeUndefined();
  });

  it.each([
    ["the old default", "[]"],
    ["the empty object form", '{"vars": {}, "scopes": [], "rules": []}'],
  ])("empties %s, sets the flag and makes no backup", async (_label, text) => {
    const loaded = await load({ rules: text });
    await endRun(await runMigration(loaded));
    expect(await loaded.rules()).toBe("");
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(backupFiles()).toEqual([]);
    expect(logs(loaded, "debug")).toContain("no rules from the previous version to move");
    expect(await loaded.kv.get("config")).toBeUndefined();
    expect((await state(loaded)).loadError).toBeNull();
  });

  it("does not set the flag when an empty list cannot be emptied", async () => {
    const loaded = await load({ rules: "[]", setting: (handle) => ({ ...handle, experimental_set: async () => { throw new Error("host down"); } }) });
    await endRun(await runMigration(loaded));
    expect(logs(loaded, "warn")).toContain(NOT_EMPTIED("host down"));
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    expect(logs(loaded, "debug")).not.toContain("no rules from the previous version to move");
  });
});

describe("the move: back up (step b)", () => {
  it("writes the text unchanged to a backup of mode 0600 in a folder of mode 0700, and logs it", async () => {
    const text = `[\n  ${JSON.stringify(OLD_RULE)}\n]\n`;
    const loaded = await load({ rules: text });
    await endRun(await runMigration(loaded));
    expect(backupFiles()).toHaveLength(1);
    const file = backupPath();
    expect(path.basename(file)).toMatch(/^rules-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{4}\.txt$/);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(backupDir()).mode & 0o777).toBe(0o700);
    expect(logs(loaded, "info")).toContain(MOVED(file));
  });

  it("skips the write when a backup with identical content is already in the folder, and names that file", async () => {
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(path.join(backupDir(), "rules-mine.txt"), OLD);
    const loaded = await load({ rules: OLD });
    await endRun(await runMigration(loaded));
    expect(backupFiles()).toEqual(["rules-mine.txt"]);
    expect(logs(loaded, "info")).toContain(MOVED(path.join(backupDir(), "rules-mine.txt")));
    expect(await loaded.rules()).toBe("");
  });

  it("counts a file it cannot read as different, not as a failure", async () => {
    mkdirSync(path.join(backupDir(), "a-folder"), { recursive: true });
    const loaded = await load({ rules: OLD });
    await endRun(await runMigration(loaded));
    expect(backupFiles().sort()).toHaveLength(2);
    expect(readFileSync(backupPath(1), "utf8")).toBe(OLD);
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
  });

  it("changes nothing when no backup can be made: a warning, a banner without a path, the setting kept, retried at the next start", async () => {
    mkdirSync(path.dirname(backupDir()), { recursive: true });
    writeFileSync(backupDir(), "a file where the folder should be");
    const loaded = await load({ rules: OLD });
    await endRun(await runMigration(loaded));
    const warning = logs(loaded, "warn").find((line) => line.startsWith("could not back up the rules from the previous version: "))!;
    const reason = warning.slice("could not back up the rules from the previous version: ".length, -"; nothing was changed, it is tried again at the next start".length);
    expect(warning).toBe(BACKUP_FAILED(reason));
    expect((await state(loaded)).loadError).toEqual({
      kind: "migration",
      message: `${reason}. No copy could be made; the rules are still in the plugin's settings and the move is tried again at the next start.`,
      backupPath: null,
    });
    expect(await loaded.rules()).toBe(OLD);
    expect(await loaded.kv.get("config")).toBeUndefined();
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    // The next start tries again, and finds the folder usable.
    rmSync(backupDir());
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    await endRun(restarted.harness.runService(SERVICE));
    expect(await restarted.bb.storage.kv.get("previousSettingDone")).toBe(true);
    expect(backupFiles()).toHaveLength(1);
  });
});

describe("the move: decide (step c) when no config is stored", () => {
  it("imports the array form, normalized, with the structural checks, and then empties the setting and sets the flag", async () => {
    const loaded = await load({ rules: JSON.stringify([{ name: "a", provider: "claude-code", project: "bb-*", skipTitles: "Help: *", instructions: ["one", "two"] }, { skills: "work-*", threads: "child" }]) });
    await endRun(await runMigration(loaded));
    expect(await loaded.kv.get("config")).toEqual(
      raw({
        rules: [
          { name: "a", provider: "claude-code", project: ["bb-*"], skipTitles: ["Help: *"], instructions: "one\ntwo" },
          { skills: ["work-*"], threads: "child" },
        ],
      }),
    );
    expect(logs(loaded, "info")).toContain("config saved from previous setting: 2 rules, 0 scopes, 0 vars");
    expect(logs(loaded, "info")).toContain(MOVED(backupPath()));
    expect(await loaded.rules()).toBe("");
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect((await state(loaded)).loadError).toBeNull();
  });

  it("imports the object form with its vars unexpanded, its scopes and its rules", async () => {
    const loaded = await load({
      rules: JSON.stringify({ vars: { a: "A" }, scopes: [{ name: "w", paths: ["/w"] }], rules: [{ scope: "w", instructions: "{{a}} text" }] }),
    });
    await endRun(await runMigration(loaded));
    expect(await loaded.kv.get("config")).toEqual(
      raw({ vars: { a: "A" }, scopes: [{ name: "w", paths: ["/w"] }], rules: [{ scope: ["w"], instructions: "{{a}} text" }] }),
    );
    expect((await configure(loaded)).instructions).toBeNull();
  });

  it("applies the imported rules at once", async () => {
    const loaded = await load({ rules: OLD });
    await endRun(await runMigration(loaded));
    expect((await configure(loaded)).instructions).toBe("From the previous version.");
  });

  it.each([
    ["not JSON", "[{", () => parseReason("[{")],
    ["a value that is not a rule list", "5", () => parseReason("5")],
    ["a rule with a reference to an unknown variable", BAD_OLD, () => "rules[0]: unknown variable {{nope}}"],
  ])("shows a migration banner with the backup path for %s, and keeps the setting", async (_label, text, why) => {
    const loaded = await load({ rules: text });
    await endRun(await runMigration(loaded));
    const file = backupPath();
    const reason = why();
    expect((await state(loaded)).loadError).toEqual({
      kind: "migration",
      message: `${reason}. A copy is in ${file}. Fix it there and run bb model-instructions import ${file}.`,
      backupPath: file,
    });
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(await loaded.rules()).toBe(text);
    expect(await loaded.kv.get("config")).toBeUndefined();
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    expect((await configure(loaded)).instructions).toBeNull();
  });
});

describe("the move: decide (step c) when a config is stored", () => {
  const SAVED = raw({ rules: [OLD_RULE] });

  it("empties the setting and sets the flag when the stored config equals the old rules, with no write of the config", async () => {
    const loaded = await load({ rules: JSON.stringify({ rules: [{ instructions: "From the previous version.", name: "old" }], vars: {} }), stored: SAVED });
    const set = vi.spyOn(loaded.kv, "set");
    await endRun(await runMigration(loaded));
    expect(await loaded.rules()).toBe("");
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(set.mock.calls.map(([key]) => key)).toEqual(["previousSettingDone"]);
    expect(await loaded.kv.get("config")).toEqual(SAVED);
    expect(logs(loaded, "info")).toContain(ALREADY_SAVED(backupPath()));
    expect(backupFiles()).toHaveLength(1);
    expect((await state(loaded)).loadError).toBeNull();
  });

  it("shows the conflict banner when the stored config differs, and changes nothing else", async () => {
    const loaded = await load({ rules: JSON.stringify([{ name: "old", instructions: "Changed." }]), stored: SAVED });
    await endRun(await runMigration(loaded));
    const file = backupPath();
    expect((await state(loaded)).loadError).toEqual({ kind: "conflict", message: CONFLICT(file), backupPath: file });
    expect(await loaded.rules()).toBe(JSON.stringify([{ name: "old", instructions: "Changed." }]));
    expect(await loaded.kv.get("config")).toEqual(SAVED);
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    expect((await configure(loaded)).instructions).toBe("From the previous version.");
  });

  it("counts a different order of rules as different", async () => {
    const two = raw({ rules: [{ instructions: "a" }, { instructions: "b" }] });
    const loaded = await load({ rules: JSON.stringify([{ instructions: "b" }, { instructions: "a" }]), stored: two });
    await endRun(await runMigration(loaded));
    expect((await state(loaded)).loadError).toMatchObject({ kind: "conflict" });
  });

  it("leaves everything untouched when the stored config is corrupt, and keeps the stored-config banner", async () => {
    const bad = { rules: [{ name: "r" }] };
    const loaded = await load({ rules: OLD, stored: bad });
    await endRun(await runMigration(loaded));
    expect(await loaded.rules()).toBe(OLD);
    expect(await loaded.kv.get("config")).toEqual(bad);
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    expect((await state(loaded)).loadError).toMatchObject({ kind: "stored" });
    // No backup either: a corrupt stored config means do nothing.
    expect(existsSync(backupDir())).toBe(false);
    expect(backupFiles()).toEqual([]);
  });

  it("lets the rules saved here win when the old text cannot be read: empties the setting, warns, shows no banner", async () => {
    const loaded = await load({ rules: "[{", stored: SAVED });
    await endRun(await runMigration(loaded));
    const file = backupPath();
    expect(readFileSync(file, "utf8")).toBe("[{");
    expect(logs(loaded, "warn")).toContain(
      `the rules from the previous version could not be read and rules are already saved here; a copy is in ${file}`,
    );
    expect(await loaded.rules()).toBe("");
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(await loaded.kv.get("config")).toEqual(SAVED);
    expect((await state(loaded)).loadError).toBeNull();
    // The text was never moved, so the log says "already saved", not "moved".
    expect(logs(loaded, "info")).toContain(ALREADY_SAVED(file));
    expect(logs(loaded, "info")).not.toContain(MOVED(file));
  });

  it("respects a form save that lands after the factory and before the service: the saved config stays, a conflict is shown", async () => {
    const loaded = await load({ rules: OLD });
    const saved = raw({ rules: [GUARD] });
    await save(loaded, saved);
    await endRun(await runMigration(loaded));
    const file = backupPath();
    expect((await state(loaded)).loadError).toEqual({ kind: "conflict", message: CONFLICT(file), backupPath: file });
    expect(await loaded.kv.get("config")).toEqual(saved);
    expect(logs(loaded, "info")).not.toContain("config saved from previous setting: 1 rules, 0 scopes, 0 vars");
    expect(await loaded.rules()).toBe(OLD);
    expect((await configure(loaded)).instructions).toBe("Guard.");
  });
});

describe("an empty saved config counts as no saved config", () => {
  it("imports the old text over a saved config with no rules, no scopes and no vars", async () => {
    const loaded = await load({ rules: OLD, stored: { vars: {}, scopes: [], rules: [] } });
    await endRun(await runMigration(loaded));
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: [OLD_RULE] }));
    expect(await loaded.rules()).toBe("");
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(logs(loaded, "info")).toContain(MOVED(backupPath()));
    expect((await state(loaded)).loadError).toBeNull();
  });

  it("does not import over a config that has only vars or only a scope", async () => {
    for (const stored of [raw({ vars: { a: "b" }, scopes: [], rules: [] }), raw({ vars: {}, scopes: [{ name: "s", paths: ["/p"] }], rules: [] })]) {
      const loaded = await load({ rules: OLD, stored });
      await endRun(await runMigration(loaded));
      expect((await state(loaded)).loadError).toMatchObject({ kind: "conflict" });
      expect(await loaded.kv.get("config")).toEqual(stored);
    }
  });

  it("explains an unreadable old text with a migration banner over an empty saved config", async () => {
    const loaded = await load({ rules: BAD_OLD, stored: { vars: {}, scopes: [], rules: [] } });
    await endRun(await runMigration(loaded));
    expect((await state(loaded)).loadError).toMatchObject({ kind: "migration" });
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
  });
});

describe("an import that lands before the move is the user's choice", () => {
  const imported = raw({ rules: [GUARD] });
  const importEarly = async (loaded: Loaded) => {
    expect((await loaded.harness.runCli(["import", importFile("early.json", imported)])).exitCode).toBe(0);
  };

  it.each([
    ["differ from", JSON.stringify([{ name: "old", instructions: "Changed." }])],
    ["equal", JSON.stringify([GUARD])],
  ])("backs up the old rules that %s the imported ones, empties the setting, sets the flag, and shows no banner", async (_label, text) => {
    const loaded = await load({ rules: text });
    await importEarly(loaded);
    expect(await loaded.rules()).toBe(text);
    await endRun(await runMigration(loaded));
    const file = backupPath();
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(backupFiles()).toHaveLength(1);
    expect(await loaded.rules()).toBe("");
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(await loaded.kv.get("config")).toEqual(imported);
    expect((await state(loaded)).loadError).toBeNull();
    expect(logs(loaded, "info")).toContain(`rules from the previous version not moved: rules were imported; backup ${file}`);
    expect(logs(loaded, "info")).not.toContain(MOVED(file));
    expect(logs(loaded, "info")).not.toContain(ALREADY_SAVED(file));
  });

  it("applies to an old text that cannot be read as well: the saved rules win", async () => {
    const loaded = await load({ rules: BAD_OLD });
    await importEarly(loaded);
    await endRun(await runMigration(loaded));
    expect((await state(loaded)).loadError).toBeNull();
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(await loaded.kv.get("config")).toEqual(imported);
    expect(backupFiles()).toHaveLength(1);
  });

  it("is not set by a form save in the same window: the conflict banner shows", async () => {
    const loaded = await load({ rules: OLD });
    await save(loaded, imported);
    await endRun(await runMigration(loaded));
    expect((await state(loaded)).loadError).toMatchObject({ kind: "conflict" });
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    expect(await loaded.rules()).toBe(OLD);
  });

  it("is not set by an import that is refused: a later form save then still gets the conflict banner", async () => {
    const loaded = await load({ rules: OLD });
    expect((await loaded.harness.runCli(["import", importFile("bad.json", { rules: [{ name: "r" }] })])).exitCode).not.toBe(0);
    await save(loaded, imported);
    await endRun(await runMigration(loaded));
    expect((await state(loaded)).loadError).toMatchObject({ kind: "conflict" });
  });

  it("is not set by an import after the move has run: the conflict is resolved the usual way", async () => {
    const loaded = await load({ rules: JSON.stringify([{ name: "old", instructions: "Changed." }]), stored: raw({ rules: [OLD_RULE] }) });
    const run = await runMigration(loaded);
    expect((await state(loaded)).loadError).toMatchObject({ kind: "conflict" });
    await importEarly(loaded);
    expect((await state(loaded)).loadError).toBeNull();
    expect(logs(loaded, "info")).toContain(MOVED(backupPath()));
    expect(logs(loaded, "info").filter((line) => line.includes("rules were imported"))).toEqual([]);
    await endRun(run);
  });
});

describe("an import before the move is finished is remembered across a restart", () => {
  const imported = raw({ rules: [GUARD] });
  const importIt = async (loaded: Loaded) =>
    expect((await loaded.harness.runCli(["import", importFile("early.json", imported)])).exitCode).toBe(0);
  /** The folder for the backups is a file, so the backup of what v0.1.12 kept fails and the move stops. */
  const blockBackups = () => {
    mkdirSync(path.dirname(backupDir()), { recursive: true });
    writeFileSync(backupDir(), "a file where the folder should be");
  };
  const V012 = { text: "[{broken" };
  const WRITE_FAILED = (reason: string) => `could not record that the rules were imported: ${reason}`;
  const DELETE_FAILED = (reason: string) => `could not remove the record that the rules were imported: ${reason}`;

  it("import, then a move that stops, then a restart: the move runs with no conflict banner, empties the setting, sets the flag and deletes the record", async () => {
    blockBackups();
    const loaded = await load({ rules: OLD, v012Rules: V012 });
    const run = await runMigration(loaded);
    expect((await state(loaded)).loadError).toMatchObject({ kind: "migration", backupPath: null });
    await importIt(loaded);
    expect(await loaded.kv.get("previousImported")).toBe(true);
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    await endRun(run);
    rmSync(backupDir());
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    await endRun(restarted.harness.runService(SERVICE));
    expect(((await restarted.harness.callRpc("getState", null)) as ConfigState).loadError).toBeNull();
    expect(await restarted.bb.storage.kv.get("config")).toEqual(imported);
    expect(await restarted.bb.storage.kv.get("previousSettingDone")).toBe(true);
    expect(await restarted.bb.storage.kv.get("previousImported")).toBeUndefined();
    // finishMove logs this only after the setting was emptied and read back.
    const files = backupFiles().map((name) => path.join(backupDir(), name));
    expect(files.map((file) => readFileSync(file, "utf8")).sort()).toEqual(["[{broken", OLD].sort());
    const oldCopy = files.find((file) => readFileSync(file, "utf8") === OLD)!;
    expect(logs(restarted, "info")).toContain(`rules from the previous version not moved: rules were imported; backup ${oldCopy}`);
  });

  it("no import, the same move that stops, then a restart: the conflict banner shows", async () => {
    blockBackups();
    const loaded = await load({ rules: OLD, v012Rules: V012, stored: imported });
    await endRun(await runMigration(loaded));
    rmSync(backupDir());
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    await endRun(restarted.harness.runService(SERVICE));
    expect(((await restarted.harness.callRpc("getState", null)) as ConfigState).loadError).toMatchObject({ kind: "conflict" });
    expect(await restarted.bb.storage.kv.get("previousSettingDone")).toBeUndefined();
    expect(await restarted.bb.storage.kv.get("previousImported")).toBeUndefined();
  });

  it("an import while the conflict banner is open: the record is written, the move finishes, the flag is set and the record is deleted", async () => {
    const loaded = await load({ rules: JSON.stringify([{ name: "old", instructions: "Changed." }]), stored: raw({ rules: [OLD_RULE] }) });
    const run = await runMigration(loaded);
    expect((await state(loaded)).loadError).toMatchObject({ kind: "conflict" });
    const writes: string[] = [];
    const original = loaded.kv.set.bind(loaded.kv);
    vi.spyOn(loaded.kv, "set").mockImplementation((async (key: string, value: unknown) => {
      writes.push(key);
      return original(key, value);
    }) as never);
    await importIt(loaded);
    expect(writes).toEqual(expect.arrayContaining(["previousImported", "previousSettingDone"]));
    expect(writes.indexOf("previousImported")).toBeLessThan(writes.indexOf("previousSettingDone"));
    expect((await state(loaded)).loadError).toBeNull();
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(await loaded.kv.get("previousImported")).toBeUndefined();
    expect(await loaded.rules()).toBe("");
    await endRun(run);
  });

  it("an import after the move finished in the same process: no record is written", async () => {
    const loaded = await load({ rules: OLD });
    await endRun(await runMigration(loaded));
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    const set = vi.spyOn(loaded.kv, "set");
    await importIt(loaded);
    expect(set.mock.calls.map(([key]) => key)).not.toContain("previousImported");
    expect(await loaded.kv.get("previousImported")).toBeUndefined();
  });

  it("a failed write of the record: a warning, and the import still exits 0 and saves the rules", async () => {
    const loaded = await load({ rules: OLD, prepare: failing("set", "previousImported") });
    await importIt(loaded);
    expect(logs(loaded, "warn")).toContain(WRITE_FAILED("disk full"));
    expect(await loaded.kv.get("config")).toEqual(imported);
    expect(await loaded.kv.get("previousImported")).toBeUndefined();
  });

  it("a failed delete of the record: a warning, no failed move, and the flag stays set", async () => {
    const loaded = await load({ rules: OLD, prepare: failing("delete", "previousImported") });
    await importIt(loaded);
    expect(await loaded.kv.get("previousImported")).toBe(true);
    await endRun(await runMigration(loaded));
    expect(logs(loaded, "warn")).toContain(DELETE_FAILED("disk full"));
    expect(logs(loaded, "warn").filter((line) => line.includes("could not be moved"))).toEqual([]);
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect((await state(loaded)).loadError).toBeNull();
    expect(await loaded.rules()).toBe("");
  });

  it("a failed read of the record: the failed-move warning, no banner, the flag not set, tried again at the next start", async () => {
    const loaded = await load({ rules: OLD, stored: imported, prepare: failing("get", "previousImported") });
    await endRun(await runMigration(loaded));
    expect(logs(loaded, "warn")).toContain(MOVE_FAILED("disk full"));
    expect((await state(loaded)).loadError).toBeNull();
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    expect(await loaded.rules()).toBe(OLD);
    // The read comes before the backup, so a read that keeps failing leaves the backups folder empty.
    expect(backupFiles()).toEqual([]);
  });

  it("a failed read of the record with no saved config: the path never uses it, so the move still finishes", async () => {
    const loaded = await load({ rules: OLD, prepare: failing("get", "previousImported") });
    await endRun(await runMigration(loaded));
    expect(logs(loaded, "warn").filter((line) => line.includes("could not be moved"))).toEqual([]);
    expect((await state(loaded)).loadError).toBeNull();
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(await loaded.rules()).toBe("");
    expect(backupFiles()).toHaveLength(1);
  });

  it("the record is deleted on the nothing-to-move path", async () => {
    const loaded = await load({ rules: "" });
    await importIt(loaded);
    expect(await loaded.kv.get("previousImported")).toBe(true);
    await endRun(await runMigration(loaded));
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(await loaded.kv.get("previousImported")).toBeUndefined();
  });
});

describe("the conflict banner is resolved", () => {
  const SAVED = raw({ rules: [OLD_RULE] });
  const CHANGED = JSON.stringify([{ name: "old", instructions: "Changed." }]);
  const inConflict = async () => {
    const loaded = await load({ rules: CHANGED, stored: SAVED });
    const run = await runMigration(loaded);
    expect((await state(loaded)).loadError).toMatchObject({ kind: "conflict" });
    return { loaded, run, file: backupPath() };
  };

  it("by a successful import: the banner clears, the setting is emptied and the flag is set", async () => {
    const { loaded, run, file } = await inConflict();
    const fixed = importFile("fixed.json", [{ name: "chosen", instructions: "Chosen." }]);
    expect(await loaded.harness.runCli(["import", fixed])).toMatchObject({ exitCode: 0 });
    expect((await state(loaded)).loadError).toBeNull();
    expect(await loaded.rules()).toBe("");
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: [{ name: "chosen", instructions: "Chosen." }] }));
    expect(logs(loaded, "info")).toContain(MOVED(file));
    await endRun(run);
  });

  it("by Keep the rules saved here (keepSavedRules): the banner clears, the setting is emptied, the saved config is unchanged", async () => {
    const { loaded, run, file } = await inConflict();
    const result = (await loaded.harness.callRpc("keepSavedRules", null)) as ConfigState;
    expect(result.loadError).toBeNull();
    expect((await state(loaded)).loadError).toBeNull();
    expect(await loaded.rules()).toBe("");
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(await loaded.kv.get("config")).toEqual(SAVED);
    expect(logs(loaded, "info")).toContain(MOVED(file));
    await endRun(run);
  });

  it("not by a form save: the banner and the setting stay", async () => {
    const { loaded, run } = await inConflict();
    const result = await save(loaded, raw({ rules: [GUARD] }));
    expect(result.loadError).toMatchObject({ kind: "conflict" });
    expect(await loaded.rules()).toBe(CHANGED);
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    await endRun(run);
  });

  it("not by a refused import: the banner and the setting stay", async () => {
    const { loaded, run } = await inConflict();
    expect((await loaded.harness.runCli(["import", importFile("refused.json", { rules: [{ name: "r" }] })])).exitCode).toBe(1);
    expect((await state(loaded)).loadError).toMatchObject({ kind: "conflict" });
    expect(await loaded.rules()).toBe(CHANGED);
    await endRun(run);
  });

  it("by nothing else: after a restart the old setting is read again and the conflict returns", async () => {
    const { loaded, run } = await inConflict();
    await endRun(run);
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    expect(restarted.harness.registrations.settingsDescriptors).toHaveProperty("rules");
    await endRun(restarted.harness.runService(SERVICE));
    expect(((await restarted.harness.callRpc("getState", null)) as ConfigState).loadError).toMatchObject({ kind: "conflict" });
    expect(backupFiles()).toHaveLength(1);
  });

  it("keepSavedRules changes nothing without a conflict banner: before the service runs, and after a move", async () => {
    const probe = spied();
    const loaded = await load({ rules: CHANGED, stored: SAVED, setting: probe.wrap });
    expect(((await loaded.harness.callRpc("keepSavedRules", null)) as ConfigState).loadError).toBeNull();
    expect(probe.set).not.toHaveBeenCalled();
    expect(await loaded.rules()).toBe(CHANGED);
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    const done = await load({ done: true });
    expect(((await done.harness.callRpc("keepSavedRules", null)) as ConfigState).loadError).toBeNull();
  });

  it("keepSavedRules does nothing while a migration banner is shown", async () => {
    const loaded = await load({ rules: "[{" });
    const run = await runMigration(loaded);
    const result = (await loaded.harness.callRpc("keepSavedRules", null)) as ConfigState;
    expect(result.loadError).toMatchObject({ kind: "migration" });
    expect(await loaded.rules()).toBe("[{");
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    await endRun(run);
  });

  it("keepSavedRules does not hide the stored-config banner, and does not run for it", async () => {
    const loaded = await load({ rules: OLD, stored: { rules: [{ name: "r" }] } });
    const run = await runMigration(loaded);
    expect(((await loaded.harness.callRpc("keepSavedRules", null)) as ConfigState).loadError).toMatchObject({ kind: "stored" });
    expect(await loaded.rules()).toBe(OLD);
    await endRun(run);
  });
});

describe("the migration banner is resolved", () => {
  const FIXED = [{ name: "fixed", instructions: "Fixed." }];
  const stuck = async (options: Options = {}) => {
    const loaded = await load({ rules: BAD_OLD, ...options });
    const run = await runMigration(loaded);
    expect((await state(loaded)).loadError).toMatchObject({ kind: "migration" });
    return { loaded, run, file: backupPath() };
  };

  it("by a successful import of a fixed backup (array form): the banner clears, the setting is emptied, the flag is set, a restart shows nothing", async () => {
    const { loaded, run, file } = await stuck();
    writeFileSync(file, JSON.stringify(FIXED));
    expect(await loaded.harness.runCli(["import", file])).toMatchObject({ exitCode: 0 });
    expect((await state(loaded)).loadError).toBeNull();
    expect(await loaded.rules()).toBe("");
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: FIXED }));
    expect(logs(loaded, "info")).toContain(MOVED(file));
    await endRun(run);
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    expect(restarted.harness.registrations.settingsDescriptors).toEqual({});
    expect(((await restarted.harness.callRpc("getState", null)) as ConfigState).loadError).toBeNull();
  });

  it("by a form save: the banner clears, the setting is emptied, the flag is set, a restart shows nothing", async () => {
    const { loaded, run, file } = await stuck();
    const result = await save(loaded, raw({ rules: FIXED }));
    expect(result.loadError).toBeNull();
    expect(await loaded.rules()).toBe("");
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(logs(loaded, "info")).toContain(MOVED(file));
    await endRun(run);
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    expect(restarted.harness.registrations.settingsDescriptors).toEqual({});
    expect(((await restarted.harness.callRpc("getState", null)) as ConfigState).loadError).toBeNull();
  });

  it("not by a refused save: the banner and the setting stay", async () => {
    const { loaded, run } = await stuck();
    await expect(save(loaded, { rules: [{ name: "r" }] })).rejects.toThrow();
    expect((await state(loaded)).loadError).toMatchObject({ kind: "migration" });
    expect(await loaded.rules()).toBe(BAD_OLD);
    await endRun(run);
  });

  it("not by a form save or an import when no copy exists: the banner and the setting stay for the next start", async () => {
    mkdirSync(path.dirname(backupDir()), { recursive: true });
    writeFileSync(backupDir(), "a file where the folder should be");
    const loaded = await load({ rules: OLD });
    const run = await runMigration(loaded);
    expect((await state(loaded)).loadError).toMatchObject({ kind: "migration", backupPath: null });
    expect((await save(loaded, raw({ rules: [GUARD] }))).loadError).toMatchObject({ kind: "migration", backupPath: null });
    expect((await loaded.harness.runCli(["import", importFile("nocopy.json", raw({ rules: [GUARD] }))])).exitCode).toBe(0);
    expect((await state(loaded)).loadError).toMatchObject({ kind: "migration", backupPath: null });
    expect(await loaded.rules()).toBe(OLD);
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    await endRun(run);
  });

  it("clears the banner even when the flag cannot be set: the next start finds the setting empty and sets it", async () => {
    const { loaded, run, file } = await stuck({ prepare: failing("set", "previousSettingDone") });
    expect((await save(loaded, raw({ rules: FIXED }))).loadError).toBeNull();
    expect(logs(loaded, "warn")).toContain(MOVE_FAILED("disk full"));
    expect(logs(loaded, "info")).not.toContain(MOVED(file));
    expect(await loaded.rules()).toBe("");
    await endRun(run);
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    await endRun(restarted.harness.runService(SERVICE));
    expect(await restarted.bb.storage.kv.get("previousSettingDone")).toBe(true);
  });

  it("keeps the config and the backup, with a warning and no flag, when the setting cannot be emptied after a save", async () => {
    const { loaded, run } = await stuck({ setting: (handle) => ({ ...handle, experimental_set: async () => { throw new Error("host down"); } }) });
    expect((await save(loaded, raw({ rules: FIXED }))).loadError).toBeNull();
    expect(logs(loaded, "warn")).toContain(NOT_EMPTIED("host down"));
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: FIXED }));
    expect(backupFiles()).toHaveLength(1);
    expect(await loaded.rules()).toBe(BAD_OLD);
    await endRun(run);
  });
});

describe("the move: empty the setting and set the flag (steps d and e)", () => {
  it("warns, sets no flag and keeps the config and the backup when the read-back is not blank", async () => {
    const loaded = await load({ rules: OLD, setting: (handle) => ({ ...handle, experimental_set: async () => ({ rules: "" }) }) });
    await endRun(await runMigration(loaded));
    expect(logs(loaded, "warn")).toContain(NOT_EMPTIED("the setting still holds a value"));
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: [OLD_RULE] }));
    expect(backupFiles()).toHaveLength(1);
    expect(logs(loaded, "info").filter((line) => line.startsWith("rules from the previous version"))).toEqual([]);
  });

  it("warns, sets no flag and keeps the config and the backup when the set throws, and tries again at the next start", async () => {
    const loaded = await load({ rules: OLD, setting: (handle) => ({ ...handle, experimental_set: async () => { throw new Error("host down"); } }) });
    await endRun(await runMigration(loaded));
    expect(logs(loaded, "warn")).toContain(NOT_EMPTIED("host down"));
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: [OLD_RULE] }));
    const first = backupFiles();
    expect(first).toHaveLength(1);
    // Next start: the config is stored and equal, so it is the equal case, and nothing is backed up twice.
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    await endRun(restarted.harness.runService(SERVICE));
    expect(await restarted.bb.storage.kv.get("previousSettingDone")).toBe(true);
    expect(backupFiles()).toEqual(first);
  });

  it("stops without a flag when the set works but the read-back fails, and the service does not crash", async () => {
    const loaded = await load({ rules: OLD, setting: (handle) => ({ ...handle, get: vi.fn().mockResolvedValueOnce({ rules: OLD }).mockRejectedValue(new Error("read-back down")) }) });
    const run = await runMigration(loaded);
    expect(logs(loaded, "warn")).toContain(NOT_EMPTIED("read-back down"));
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    await endRun(run);
  });

  it("logs a failed set of the flag as a warning, keeps the setting empty, and retries it at the next start", async () => {
    const loaded = await load({ rules: OLD, prepare: failing("set", "previousSettingDone") });
    await endRun(await runMigration(loaded));
    expect(logs(loaded, "warn")).toContain(MOVE_FAILED("disk full"));
    expect(await loaded.rules()).toBe("");
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    await endRun(restarted.harness.runService(SERVICE));
    expect(await restarted.bb.storage.kv.get("previousSettingDone")).toBe(true);
    expect(logs(restarted, "debug")).toContain("no rules from the previous version to move");
  });

  it("logs a failed write of the imported config as a warning, shows a banner with the backup path, and changes nothing else", async () => {
    const loaded = await load({ rules: OLD, prepare: failing("set", "config") });
    await endRun(await runMigration(loaded));
    expect(logs(loaded, "warn")).toContain(MOVE_FAILED("disk full"));
    expect(await loaded.rules()).toBe(OLD);
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    const file = backupPath();
    expect((await state(loaded)).loadError).toEqual({
      kind: "migration",
      message: `the rules could not be saved: disk full. A copy is in ${file}; the move is tried again at the next start, or run bb model-instructions import ${file}.`,
      backupPath: file,
    });
  });
});

describe("the background service", () => {
  it("resolves only on abort, and runs the move once", async () => {
    const loaded = await load({ rules: OLD });
    const run = loaded.harness.runService(SERVICE);
    await settle();
    const status = await Promise.race([run.done.then(() => "resolved"), settle().then(() => "pending")]);
    expect(status).toBe("pending");
    expect(logs(loaded, "info").filter((line) => line.startsWith("rules from the previous version moved"))).toHaveLength(1);
    run.controller.abort();
    await expect(run.done).resolves.toBeUndefined();
  });

  it("resolves at once for a signal that is already aborted, after the move", async () => {
    const loaded = await load({ rules: OLD });
    const service = loaded.harness.registrations.services.find((record) => record.name === SERVICE)!;
    const controller = new AbortController();
    controller.abort();
    await expect(service.start(controller.signal)).resolves.toBeUndefined();
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
  });

  it("never rejects, and warns, when the read of the setting rejects", async () => {
    const loaded = await load({ rules: OLD, setting: (handle) => ({ ...handle, get: async () => { throw new Error("404 not found"); } }) });
    const run = loaded.harness.runService(SERVICE);
    await settle();
    expect(logs(loaded, "warn")).toContain(MOVE_FAILED("404 not found"));
    const status = await Promise.race([run.done.then(() => "resolved", () => "rejected"), settle().then(() => "pending")]);
    expect(status).toBe("pending");
    run.controller.abort();
    await expect(run.done).resolves.toBeUndefined();
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
  });

  it("does not stop the next write: a later form save still works after a failed move", async () => {
    const loaded = await load({ rules: OLD, prepare: failing("set", "config") });
    await endRun(await runMigration(loaded));
    vi.restoreAllMocks();
    expect((await save(loaded, raw({ rules: [GUARD] }))).loadError).toBeNull();
  });
});

describe("what v0.1.12 kept in kv is cleaned up once, at the start of the move", () => {
  it("backs up the kept text, and deletes the record only after that", async () => {
    const loaded = await load({ rules: "", v012Rules: { text: "[{broken", error: "why" } });
    const deleted: string[] = [];
    const original = loaded.kv.delete.bind(loaded.kv);
    vi.spyOn(loaded.kv, "delete").mockImplementation(async (key: string) => {
      deleted.push(`${key}:${backupFiles().length}`);
      return original(key);
    });
    await endRun(await runMigration(loaded));
    expect(deleted).toContain("legacyRules:1");
    expect(backupFiles()).toHaveLength(1);
    expect(readFileSync(backupPath(), "utf8")).toBe("[{broken");
    expect(await loaded.kv.get("legacyRules")).toBeUndefined();
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
  });

  it("deletes the dismissed flag", async () => {
    const loaded = await load({ rules: "", v012Dismissed: true });
    await endRun(await runMigration(loaded));
    expect(await loaded.kv.get("legacyDismissed")).toBeUndefined();
  });

  it("does not make a second copy of a text that already has a backup", async () => {
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(path.join(backupDir(), "rules-mine.txt"), "[{broken");
    const loaded = await load({ rules: "", v012Rules: { text: "[{broken", error: "why" } });
    await endRun(await runMigration(loaded));
    expect(backupFiles()).toEqual(["rules-mine.txt"]);
    expect(await loaded.kv.get("legacyRules")).toBeUndefined();
  });

  it("keeps the record, warns, and moves nothing else when its backup fails", async () => {
    mkdirSync(path.dirname(backupDir()), { recursive: true });
    writeFileSync(backupDir(), "a file where the folder should be");
    const loaded = await load({ rules: OLD, v012Rules: { text: "[{broken", error: "why" } });
    await endRun(await runMigration(loaded));
    expect(logs(loaded, "warn").filter((line) => line.startsWith("could not back up the rules from the previous version: "))).toHaveLength(1);
    expect(await loaded.kv.get("legacyRules")).toEqual({ text: "[{broken", error: "why" });
    expect(await loaded.rules()).toBe(OLD);
    expect(await loaded.kv.get("config")).toBeUndefined();
    const warning = logs(loaded, "warn").find((line) => line.startsWith("could not back up the rules from the previous version: "))!;
    const reason = warning.slice("could not back up the rules from the previous version: ".length, -"; nothing was changed, it is tried again at the next start".length);
    expect((await state(loaded)).loadError).toEqual({
      kind: "migration",
      message: `the rules text saved by version 0.1.12 could not be backed up: ${reason}. No copy could be made; the rules are still in the plugin's settings and the move is tried again at the next start.`,
      backupPath: null,
    });
  });

  it.each([
    ["has no text", { error: "why" }],
    ["is not an object", "text"],
    ["has a text that is not a string", { text: 5 }],
  ])("deletes a record that %s, with a warning, and makes no backup", async (_label, record) => {
    const loaded = await load({ rules: "", v012Rules: record });
    await endRun(await runMigration(loaded));
    expect(await loaded.kv.get("legacyRules")).toBeUndefined();
    expect(logs(loaded, "warn")).toContain("stored rules record of an earlier version ignored: wrong shape");
    expect(backupFiles()).toEqual([]);
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
  });

  it("keeps going, with no warning and no delete of the record, when there is nothing of v0.1.12 in kv", async () => {
    const loaded = await load({ rules: "" });
    const deleted = vi.spyOn(loaded.kv, "delete");
    await endRun(await runMigration(loaded));
    expect(await loaded.kv.get("previousSettingDone")).toBe(true);
    expect(logs(loaded, "warn")).not.toContain("stored rules record of an earlier version ignored: wrong shape");
    expect(deleted.mock.calls.map(([key]) => key)).not.toContain("legacyRules");
  });

  it("warns and keeps the move for the next start when a delete fails", async () => {
    const loaded = await load({ rules: OLD, v012Dismissed: true, prepare: failing("delete", "legacyDismissed") });
    await endRun(await runMigration(loaded));
    expect(logs(loaded, "warn")).toContain(MOVE_FAILED("disk full"));
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
  });

  it("ignores a stale v0.1.12 key once the flag is set: no banner, no service", async () => {
    const loaded = await load({ done: true, v012Rules: { text: "old", error: "why" } });
    expect((await state(loaded)).loadError).toBeNull();
    expect(serviceNames(loaded)).not.toContain(SERVICE);
  });
});

// AGENTS.md quirk ledger: both findings below were learned from the live probe of 2026-11-11 on a real host,
// which showed why model-instructions v0.1.12 lost its rules on upgrade.
describe("quirk ledger: what bb does with a setting the plugin has not declared (live probe 2026-11-11, v0.1.12)", () => {
  // Live finding: `getSettings` for an undeclared setting returns no keys, and during the plugin's own factory it
  // answers 404. Re-declaring the setting (a `define` placed after an `await` in the async factory is registered)
  // makes `settings.get()` return the stored value.
  it("reads the old value only through the declared setting, never through getSettings of an undeclared key", async () => {
    const order: string[] = [];
    const probe = spied();
    const loaded = await load({
      rules: OLD,
      setting: (handle) => {
        order.push("define");
        const wrapped = probe.wrap(handle);
        return {
          ...wrapped,
          get: () => {
            order.push("get");
            return wrapped.get();
          },
        };
      },
      prepare: (kv) => {
        const get = kv.get.bind(kv) as (key: string) => Promise<unknown>;
        vi.spyOn(kv, "get").mockImplementation((async (key: string) => {
          order.push(`kv.get:${key}`);
          return get(key);
        }) as never);
      },
    });
    // The declaration comes after the awaited reads of the factory.
    expect(order.indexOf("define")).toBeGreaterThan(order.indexOf("kv.get:previousSettingDone"));
    expect(order.indexOf("define")).toBeGreaterThan(order.indexOf("kv.get:config"));
    await endRun(await runMigration(loaded));
    expect(order.indexOf("get")).toBeGreaterThan(order.indexOf("define"));
    expect(probe.get).toHaveBeenCalled();
    expect(loaded.getSettings).not.toHaveBeenCalled();
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: [OLD_RULE] }));
  });

  // Live finding: `settings.experimental_set({ rules: null })` from a background service empties the setting, and
  // `settings.get()` then reads "". The factory cannot write it: bb answers 404 until the factory has finished.
  it("writes the setting only from the background service, after the factory, never inside the factory", async () => {
    const probe = spied();
    const loaded = await load({ rules: OLD, setting: probe.wrap });
    // The factory has finished: it has read nothing of the setting and written nothing.
    expect(probe.get).not.toHaveBeenCalled();
    expect(probe.set).not.toHaveBeenCalled();
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
    expect(await loaded.kv.get("config")).toBeUndefined();
    expect(await loaded.rules()).toBe(OLD);
    await endRun(await runMigration(loaded));
    expect(probe.set).toHaveBeenCalledTimes(1);
    expect(probe.set).toHaveBeenCalledWith({ rules: null });
    expect(await loaded.rules()).toBe("");
  });

  // Live finding: a background service whose `start` awaits abort runs once and is not restarted; when the setting
  // is not declared, bb reports that the plugin declares no settings.
  it("keeps the service running until abort, so bb does not restart it, and declares nothing after the move", async () => {
    const loaded = await load({ rules: OLD });
    const run = loaded.harness.runService(SERVICE);
    await settle();
    expect(await Promise.race([run.done.then(() => "returned"), settle().then(() => "running")])).toBe("running");
    run.controller.abort();
    await run.done;
    const restarted = await loaded.harness.reload(loaded.create);
    await flush();
    expect(restarted.harness.registrations.settingsDescriptors).toEqual({});
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

  it.each(["previousSettingDone", "config"])(
    "(%s) still registers configure, RPC and CLI, warns, runs with no rules and shows the storage banner",
    async (key) => {
      const loaded = await load({ rules: JSON.stringify([GUARD]), prepare: readFails(key) });
      expect(logs(loaded, "warn")).toContain(READ(key));
      expect((await state(loaded)).loadError).toEqual({ kind: "storage", message: MESSAGE(key) });
      expect((await configure(loaded)).instructions).toBeNull();
      const status = await loaded.harness.runCli(["status"]);
      expect(status.exitCode).toBe(0);
    },
  );

  it.each(["previousSettingDone", "config"])(
    "(%s) declares no setting, registers no service and moves nothing",
    async (key) => {
      const loaded = await load({ rules: JSON.stringify([GUARD]), prepare: readFails(key) });
      expect(loaded.harness.registrations.settingsDescriptors).toEqual({});
      expect(serviceNames(loaded)).not.toContain(SERVICE);
      expect(loaded.getSettings).not.toHaveBeenCalled();
      expect(await loaded.kv.get("config")).toBeUndefined();
      expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
      expect(backupFiles()).toEqual([]);
    },
  );

  it("does not adopt a stored config when the flag read failed", async () => {
    const loaded = await load({ stored: raw({ rules: [GUARD] }), prepare: readFails("previousSettingDone") });
    expect((await configure(loaded)).instructions).toBeNull();
  });

  it("shows the storage banner, not a stored-config error, when the config read failed", async () => {
    const loaded = await load({ rules: OLD, prepare: readFails("config") });
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

  it("changes nothing for keepSavedRules, and keeps the storage banner", async () => {
    const loaded = await load({ prepare: readFails("config") });
    const result = (await loaded.harness.callRpc("keepSavedRules", null)) as ConfigState;
    expect(result.loadError).toMatchObject({ kind: "storage" });
    expect(await loaded.kv.get("previousSettingDone")).toBeUndefined();
  });

  it("is normal without the failure: no banner, saves work", async () => {
    const loaded = await load({ rules: "[]" });
    expect((await state(loaded)).loadError).toBeNull();
    expect((await save(loaded, raw({ rules: [GUARD] }))).loadError).toBeNull();
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
      text: JSON.stringify(BAD, null, 2),
    });
    expect((await configure(loaded)).instructions).toBeNull();
    expect(await loaded.kv.get("config")).toEqual(BAD);
  });

  it("has an empty text when the stored value has no JSON text", async () => {
    const loaded = await load({ prepare: (kv) => void vi.spyOn(kv, "get").mockImplementation((async (key: string) => (key === "config" ? { rules: 1n } : undefined)) as never) });
    expect((await state(loaded)).loadError).toEqual({ kind: "stored", message: expect.stringContaining(PREFIX), text: "" });
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

  it("is not touched by keepSavedRules", async () => {
    const loaded = await load({ stored: BAD });
    expect(((await loaded.harness.callRpc("keepSavedRules", null)) as ConfigState).loadError).toMatchObject({ kind: "stored" });
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
      (await loaded.harness.callRpc("keepSavedRules", null)) as ConfigState,
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
    expect(loaded.harness.registrations.rpcMethods.sort()).toEqual([
      "getState",
      "keepSavedRules",
      "resolvePluginSelection",
      "saveConfig",
    ]);
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
    for (const loadError of [
      { kind: "storage", message: "m" },
      { kind: "stored", message: "m", text: "t" },
      { kind: "migration", message: "m", backupPath: null },
      { kind: "migration", message: "m", backupPath: "/b" },
      { kind: "conflict", message: "m", backupPath: "/b" },
    ])
      expect(output.safeParse({ ...valid, loadError }).success).toBe(true);
    for (const loadError of [
      { kind: "legacy", message: "m", legacyText: "" },
      { kind: "storage", message: "m", text: "" },
      { kind: "stored", message: "m" },
      { kind: "migration", message: "m" },
      { kind: "migration", message: "m", backupPath: "/b", extra: 1 },
      { kind: "conflict", message: "m", backupPath: null },
    ])
      expect(output.safeParse({ ...valid, loadError }).success).toBe(false);
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

  it("imports the array form of the previous versions as it is, so a backup file imports", async () => {
    const loaded = await load();
    const file = importFile("array.json", [{ name: "r", skills: "work-*", instructions: ["a", "b"] }]);
    expect(await loaded.harness.runCli(["import", file])).toMatchObject({
      exitCode: 0,
      stdout: `imported ${file}: 1 rules, 0 scopes, 0 vars\n`,
    });
    expect(await loaded.kv.get("config")).toEqual(raw({ rules: [{ name: "r", skills: ["work-*"], instructions: "a\nb" }] }));
    expect(logs(loaded, "info")).toContain("config saved from import: 1 rules, 0 scopes, 0 vars");
  });

  it("fails an import of an invalid file, array form included, and changes nothing", async () => {
    const stored = raw({ rules: [GUARD] });
    const loaded = await load({ stored });
    for (const content of ["[{", '[{"instructions": ""}]', '[{"scope": "nowhere", "instructions": "x"}]', "5"]) {
      const result = await loaded.harness.runCli(["import", importFile("bad.json", content)]);
      expect(result.exitCode).toBe(1);
    }
    expect(await loaded.kv.get("config")).toEqual(stored);
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
    const refusedResult = expect(refused).rejects.toThrow(
      'a rule needs "instructions", "skills", "plugins", or a combination',
    );
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

describe("plugin selection with unavailable stored configuration", () => {
  it("fails without returning a selection result", async () => {
    const loaded = await load({ stored: { rules: [{ plugins: [] }] } });
    await expect(
      loaded.harness.callRpc(
        "resolvePluginSelection",
        {
          version: 1,
          target: {
            provider: { id: "claude-code", model: "opus" },
            thread: { id: "thr_1", title: null, parentThreadId: null },
            project: { id: "proj_1", name: "bb-plugins" },
            environment: { id: "env_1", path: "/tmp/none" },
          },
        },
        { experimental_caller: { kind: "plugin", pluginId: "example-plugin" } },
      ),
    ).rejects.toThrow(
      "Model instructions configuration is unavailable. Open its settings to resolve the reported error.",
    );
  });
});
