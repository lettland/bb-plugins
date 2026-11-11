import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { snapshotOf } from "./cache-fixture.js";
import { formatImport, importCommand, type ImportDeps, type ImportReport } from "./import.js";
import { mergeScopes, readProfiles, type ProfileScope } from "./profiles-file.js";
import { settingProblem } from "./settings.js";

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "model-instructions-import-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SKILLS = ["model-instructions", "work-conventions", "other"];
const GUARD = { name: "guard", instructions: "Guard." };

interface Options {
  scopes?: unknown;
  ui?: unknown[];
  pins?: unknown[];
  /** The export file's whole text or content; undefined writes a default, null leaves the file out. */
  exportData?: unknown;
  rules?: string;
  profiles?: unknown;
  kv?: Record<string, unknown>;
  setError?: string;
}

function put(file: string, content: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

function harness(opts: Options = {}) {
  const base = mkdtempSync(path.join(tmp, "h-"));
  const home = path.join(base, "home");
  const files = {
    scopes: path.join(home, ".bb", "dir-skills", "scopes.json"),
    export: path.join(home, ".bb", "dir-skills", "export.json"),
    profiles: path.join(home, ".bb", "model-instructions", "profiles.json"),
  };
  mkdirSync(home, { recursive: true });
  if (opts.scopes !== undefined) put(files.scopes, opts.scopes);
  if (opts.exportData !== null)
    put(files.export, opts.exportData ?? { uiScopes: opts.ui ?? [], pins: opts.pins ?? [] });
  if (opts.profiles !== undefined) put(files.profiles, opts.profiles);
  const kv = new Map<string, unknown>(Object.entries(opts.kv ?? {}));
  const state = { rules: opts.rules ?? "[]", reloads: 0, sets: [] as string[], logs: [] as string[] };
  const profileScopes = (): ProfileScope[] => {
    const read = readProfiles(files.profiles, home);
    return read.state === "valid" ? read.scopes : [];
  };
  const env = (profiles: () => ProfileScope[]) => ({
    skillNames: () => SKILLS,
    scopesFor: (own: Parameters<typeof mergeScopes>[0]) => mergeScopes(own, profiles()).scopes,
    caches: () => snapshotOf([["claude-code", ["opus"]]], []),
  });
  const deps: ImportDeps = {
    home,
    scopesFile: files.scopes,
    exportFile: files.export,
    profilesFile: files.profiles,
    skillNames: () => SKILLS,
    getRules: async () => state.rules,
    async setRules(json) {
      if (opts.setError !== undefined) throw new Error(opts.setError);
      // Like the SDK: the save-time check runs against what is loaded now.
      const problem = settingProblem(json, env(() => profileScopes()));
      if (problem !== null) throw new Error(problem);
      state.rules = json;
      state.sets.push(json);
    },
    validate: (json, scopes) => settingProblem(json, env(() => scopes)),
    reloadProfiles() {
      state.reloads += 1;
    },
    kv: {
      get: async <T,>(key: string) => kv.get(key) as T | undefined,
      set: async (key: string, value: unknown) => void kv.set(key, value),
    },
    log: { info: (message) => void state.logs.push(message), warn: (message) => void state.logs.push(message) },
  };
  return { deps, files, kv, state, home, base };
}

type H = ReturnType<typeof harness>;

async function run(h: H, flags: string[] = [], json = false) {
  return importCommand(h.deps, flags, json);
}

async function report(h: H, flags: string[] = []): Promise<ImportReport & { ok: boolean }> {
  const result = await run(h, flags, true);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout!);
}

const scope = (over: Record<string, unknown> = {}) => ({ name: "acme", paths: ["~/src/acme"], skills: ["work-*"], ...over });
const profiled = (over: Record<string, unknown> = {}) => scope({ name: "prof", claudeConfigDir: "~/.claude-acme", ...over });
const profDir = (h: H) => path.join(h.home, ".claude-acme");

describe("arguments and files", () => {
  it("rejects unknown flags with a usage line", async () => {
    const result = await run(harness(), ["--force"]);
    expect(result).toEqual({
      exitCode: 2,
      stderr: "usage: bb model-instructions import-dir-skills [--dry-run] [--json]\n",
    });
  });

  it("needs export.json and names the fix, as text and as JSON", async () => {
    const h = harness({ exportData: null });
    const message = "import-dir-skills: ~/.bb/dir-skills/export.json not found; run bb dir-skills export first";
    expect(await run(h)).toEqual({ exitCode: 1, stderr: message + "\n" });
    const json = await run(h, [], true);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout!)).toEqual({ ok: false, errors: [message] });
  });

  it("reports a file it cannot read", async () => {
    const h = harness();
    rmSync(h.files.export);
    mkdirSync(h.files.export);
    const result = await run(h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/could not read ~\/\.bb\/dir-skills\/export\.json: EISDIR/);
  });

  it("rejects an export file that is not JSON or has the wrong shape", async () => {
    expect((await run(harness({ exportData: "{" }))).stderr).toBe("~/.bb/dir-skills/export.json: not valid JSON\n");
    const wrong = await run(harness({ exportData: { uiScopes: [{ name: "a", paths: [], skills: [], claudeConfigDir: "/x" }], pins: [] } }));
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toMatch(/export\.json: [\s\S]*Unrecognized key/);
    expect((await run(harness({ exportData: { uiScopes: [] } }))).stderr).toMatch(/pins/);
  });

  it("rejects a scopes.json that is not JSON or has the wrong shape, and writes nothing", async () => {
    for (const [scopes, text] of [
      ["{", "scopes.json: not valid JSON"],
      [{ nope: 1 }, 'scopes.json: expected { "scopes": [...] }'],
      ["null", 'scopes.json: expected { "scopes": [...] }'],
      [{ scopes: [{ name: "a", skills: ["x"] }] }, "scopes.json: scope 1:"],
      [{ scopes: ["a"] }, "scopes.json: scope 1:"],
    ] as const) {
      const h = harness({ scopes });
      const result = await run(h);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(text);
      expect(existsSync(h.files.profiles)).toBe(false);
    }
  });

  it("treats an absent scopes.json as no scopes", async () => {
    const out = await report(harness({ ui: [scope()] }));
    expect(out.settingScopes).toEqual([{ name: "acme", paths: ["~/src/acme"] }]);
  });
});

describe("the import", () => {
  it("writes profiles.json, the setting (array → object, every rule unchanged and in order) and the pins", async () => {
    const existing = [GUARD, { name: "second", model: "opus*", threads: "child", instructions: ["a", "b"] }];
    const h = harness({
      rules: JSON.stringify(existing),
      scopes: { scopes: [scope({ name: "plain", skills: ["other"] }), profiled()] },
      ui: [scope({ name: "ui-only", paths: ["/srv/ui"], skills: ["work-*", "other"] })],
    });
    // The profile dir depends on this harness's home.
    put(h.files.export, {
      uiScopes: [scope({ name: "ui-only", paths: ["/srv/ui"], skills: ["work-*", "other"] })],
      pins: [
        { threadId: "thr_default", pin: { dir: null, scope: null, reason: "unknown-project" } },
        { threadId: "thr_prof", pin: { dir: profDir(h), scope: "prof" } },
      ],
    });
    const result = await run(h);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(h.files.profiles, "utf8"))).toEqual({
      scopes: [{ name: "prof", paths: ["~/src/acme"], claudeConfigDir: "~/.claude-acme" }],
    });
    expect(h.state.reloads).toBe(1);
    expect(h.state.sets).toHaveLength(1);
    expect(JSON.parse(h.state.rules)).toEqual({
      vars: {},
      scopes: [
        { name: "plain", paths: ["~/src/acme"] },
        { name: "ui-only", paths: ["/srv/ui"] },
      ],
      rules: [
        ...existing,
        { name: "dir-skills:plain", scope: "plain", skills: ["other"] },
        { name: "dir-skills:prof", scope: "prof", skills: ["work-*"] },
        { name: "dir-skills:ui-only", scope: "ui-only", skills: ["work-*", "other"] },
      ],
    });
    expect([...h.kv]).toEqual([
      ["claude-config-dir:thr_default", { dir: null, scope: null, reason: "unknown-project" }],
      ["claude-config-dir:thr_prof", { dir: profDir(h), scope: "prof" }],
    ]);
    expect(result.stdout).toContain("import-dir-skills: done");
    expect(result.stdout).toContain("profiles.json (absent before): wrote 1 scope(s): prof");
    expect(result.stdout).toContain("rules setting: wrote 2 scope(s), 3 rule(s)");
    expect(result.stdout).toContain("pins: 2 imported, 0 kept, 0 rejected");
    expect(result.stdout).toContain("thr_default: default profile");
    expect(h.state.logs).toContain("import-dir-skills: 2 scope(s), 3 rule(s), 2 pin(s), 1 profile scope(s)");
    expect(result.stdout).toContain("needs `bb model-instructions unpin <thread-id>`");
  });

  it("keeps an object-form setting's keys and appends after its scopes and rules", async () => {
    const existing = {
      vars: { gchat: "Chat." },
      scopes: [{ name: "mine", paths: ["/mine"] }],
      rules: [{ name: "r", scope: "mine", instructions: "{{gchat}}" }],
    };
    const h = harness({ rules: JSON.stringify(existing), ui: [scope()] });
    await report(h);
    expect(JSON.parse(h.state.rules)).toEqual({
      vars: existing.vars,
      scopes: [...existing.scopes, { name: "acme", paths: ["~/src/acme"] }],
      rules: [...existing.rules, { name: "dir-skills:acme", scope: "acme", skills: ["work-*"] }],
    });
  });

  it("adds a scopes list to an object-form setting that has none", async () => {
    const h = harness({ rules: JSON.stringify({ rules: [GUARD] }), ui: [scope()] });
    await report(h);
    expect(JSON.parse(h.state.rules)).toEqual({
      rules: [GUARD, { name: "dir-skills:acme", scope: "acme", skills: ["work-*"] }],
      scopes: [{ name: "acme", paths: ["~/src/acme"] }],
    });
  });

  it("refuses an existing setting that does not parse, and writes nothing", async () => {
    const h = harness({ rules: "{", ui: [scope()], scopes: { scopes: [profiled()] } });
    const result = await run(h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/the rules setting does not parse \(not valid JSON[\s\S]*\); fix it first \(nothing was written\)/);
    expect(existsSync(h.files.profiles)).toBe(false);
    expect(h.state.sets).toEqual([]);
  });

  it("leaves the setting alone and writes no pin or file when there is nothing to add; a second run is a no-op", async () => {
    const h = harness({ rules: "[]", ui: [scope()], pins: [{ threadId: "thr_a", pin: { dir: null, scope: null } }] });
    await report(h);
    const first = h.state.rules;
    const again = await report(h);
    expect(h.state.rules).toBe(first);
    expect(h.state.sets).toHaveLength(1);
    expect(again.settingChanged).toBe(false);
    expect(again.pins.kept).toEqual(["thr_a"]);
    expect(again.skipped.map((item) => item.reason)).toEqual([
      "the rules setting already has a scope with that name",
    ]);
  });

  it("does not write the setting when every scope is skipped; the text says unchanged", async () => {
    const h = harness({ ui: [scope({ name: "work", paths: ["~/workspace/work"] })] });
    const out = await report(h);
    expect(out.settingChanged).toBe(false);
    expect(h.state.sets).toEqual([]);
    const text = formatImport({ ...out, dryRun: false });
    expect(text).toContain("rules setting: unchanged");
  });
});

describe("which scopes are imported", () => {
  it("never imports the shipped example, from either source", async () => {
    const example = { name: "work", paths: ["~/workspace/work"], skills: ["work-*"] };
    const h = harness({ scopes: { scopes: [example] }, ui: [example] });
    const out = await report(h);
    expect(out.settingScopes).toEqual([]);
    expect(out.rules).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual([
      "the shipped dir-skills example scope is never imported",
      "the shipped dir-skills example scope is never imported",
    ]);
  });

  it("does not take a work scope that differs from the example, or a profile scope named work, for the example", async () => {
    const h = harness({
      scopes: { scopes: [{ name: "work", paths: ["~/workspace/work"], skills: ["work-*"], claudeConfigDir: "~/.claude-work" }] },
      ui: [{ name: "work", paths: ["~/elsewhere"], skills: ["work-*"] }],
    });
    const out = await report(h);
    expect(out.profileScopes.map((s) => s.name)).toEqual(["work"]);
    expect(out.settingScopes).toEqual([]);
  });

  it("lets a UI scope replace a scopes.json scope without a profile, keeping its position", async () => {
    const h = harness({
      scopes: { scopes: [scope({ name: "a", paths: ["/file-a"] }), scope({ name: "b", paths: ["/file-b"] })] },
      ui: [scope({ name: "a", paths: ["/ui-a"], skills: ["other"] })],
    });
    const out = await report(h);
    expect(out.settingScopes).toEqual([
      { name: "a", paths: ["/ui-a"] },
      { name: "b", paths: ["/file-b"] },
    ]);
    expect(out.rules.find((rule) => rule.scope === "a")?.skills).toEqual(["other"]);
  });

  it("never lets a UI scope replace a scopes.json scope with a profile", async () => {
    const h = harness({
      scopes: { scopes: [profiled({ name: "x", paths: ["/file-x"] })] },
      ui: [scope({ name: "x", paths: ["/ui-x"], skills: ["other"] })],
    });
    const out = await report(h);
    expect(out.settingScopes).toEqual([]);
    expect(out.profileScopes).toEqual([{ name: "x", paths: ["/file-x"], claudeConfigDir: "~/.claude-acme" }]);
    expect(out.rules).toEqual([{ name: "dir-skills:x", scope: "x", skills: ["work-*"] }]);
    expect(out.skipped).toEqual([
      {
        kind: "scope",
        name: "x",
        reason: "a UI scope never replaces the profile scope of the same name in ~/.bb/dir-skills/scopes.json",
      },
    ]);
  });

  it("lets a later scope of the same name in scopes.json replace the earlier one, and names an unnamed scope scope-N", async () => {
    const h = harness({
      scopes: { scopes: [scope({ name: "d", paths: ["/one"] }), { paths: ["/two"], skills: ["other"] }, { name: "  ", paths: ["/three"], skills: ["other"] }, scope({ name: " d ", paths: ["/four"] })] },
    });
    const out = await report(h);
    expect(out.settingScopes).toEqual([
      { name: "d", paths: ["/four"] },
      { name: "scope-2", paths: ["/two"] },
      { name: "scope-3", paths: ["/three"] },
    ]);
  });

  it("trims names, paths and skills of UI scopes", async () => {
    const out = await report(harness({ ui: [{ name: " t ", paths: [" /p "], skills: [" other "] }] }));
    expect(out.settingScopes).toEqual([{ name: "t", paths: ["/p"] }]);
    expect(out.rules).toEqual([{ name: "dir-skills:t", scope: "t", skills: ["other"] }]);
  });
});

describe("names, paths and profile dirs are checked before anything is written", () => {
  it.each([
    ["a name with a control character", scope({ name: "bad\nname" }), /scope "bad\\nname": [\s\S]*control characters/],
    ["a name over 128 characters", scope({ name: "n".repeat(129) }), /scope "n+": [\s\S]*name/],
    ["a name whose rule name is over 128 characters", scope({ name: "n".repeat(120) }), /the rule name "dir-skills:n+" is too long/],
    ["a relative path", scope({ paths: ["relative"] }), /scope "acme": [\s\S]*absolute path/],
    ["a profile dir that is the home directory", profiled({ claudeConfigDir: "~/" }), /scope "prof": [\s\S]*home directory/],
  ])("rejects %s, lists it, exits 1 and writes nothing", async (_label, bad, pattern) => {
    for (const source of ["file", "ui"] as const) {
      if (source === "ui" && (bad as { claudeConfigDir?: unknown }).claudeConfigDir !== undefined) continue;
      const h = harness({
        scopes: { scopes: source === "file" ? [bad, profiled({ name: "fine" })] : [] },
        ui: source === "ui" ? [bad] : [],
        pins: [{ threadId: "thr_1", pin: { dir: null, scope: null } }],
      });
      const result = await run(h);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/fix them in the source files and run again \(nothing was written\)/);
      expect(result.stderr).toMatch(pattern);
      expect(existsSync(h.files.profiles)).toBe(false);
      expect(h.state.sets).toEqual([]);
      expect(h.kv.size).toBe(0);
      const json = JSON.parse((await run(h, [], true)).stdout!);
      expect(json.ok).toBe(false);
    }
  });

  it("lists every rejected scope, not just the first", async () => {
    const h = harness({ ui: [scope({ name: "a\tb" }), scope({ name: "c\u0000d" })] });
    const lines = (await run(h)).stderr!.split("\n").filter((line) => line.startsWith("  scope "));
    expect(lines).toHaveLength(2);
  });
});

describe("skill patterns", () => {
  it("skips a pattern that matches no bundled skill, keeps the ones that match, and still imports the scope", async () => {
    const h = harness({ ui: [scope({ skills: ["typo-*", "work-*", "model-instructions"] })] });
    const out = await report(h);
    expect(out.rules).toEqual([{ name: "dir-skills:acme", scope: "acme", skills: ["work-*"] }]);
    expect(out.skipped).toEqual([
      { kind: "skills", name: "dir-skills:acme", reason: 'no bundled skill matches "typo-*"' },
      { kind: "skills", name: "dir-skills:acme", reason: 'no bundled skill matches "model-instructions"' },
    ]);
    expect(formatImport({ ...out, dryRun: true })).toContain(
      'skipped: no bundled skill matches "typo-*" (skills "dir-skills:acme")',
    );
    expect(out.settingScopes).toEqual([{ name: "acme", paths: ["~/src/acme"] }]);
  });

  it("writes no rule when no pattern matches, and none for a scope with no skills", async () => {
    const h = harness({ ui: [scope({ skills: ["typo-*"] }), scope({ name: "bare", skills: [] })] });
    const out = await report(h);
    expect(out.rules).toEqual([]);
    expect(out.settingScopes.map((s) => s.name)).toEqual(["acme", "bare"]);
    expect(JSON.parse(h.state.rules).rules).toEqual([]);
  });
});

describe("collisions", () => {
  it("skips a scope that the setting already has, together with its rule", async () => {
    const h = harness({
      rules: JSON.stringify({ scopes: [{ name: "acme", paths: ["/mine"] }], rules: [GUARD] }),
      ui: [scope(), scope({ name: "fresh" })],
    });
    const out = await report(h);
    expect(out.settingScopes.map((s) => s.name)).toEqual(["fresh"]);
    expect(out.rules.map((r) => r.name)).toEqual(["dir-skills:fresh"]);
    expect(out.skipped).toEqual([
      { kind: "scope", name: "acme", reason: "the rules setting already has a scope with that name" },
    ]);
  });

  it("skips a rule whose name is taken but imports the scope", async () => {
    const h = harness({
      rules: JSON.stringify([{ name: "dir-skills:acme", instructions: "mine" }, { instructions: "unnamed" }]),
      ui: [scope()],
    });
    const out = await report(h);
    expect(out.settingScopes.map((s) => s.name)).toEqual(["acme"]);
    expect(out.rules).toEqual([]);
    expect(out.skipped).toEqual([
      { kind: "rule", name: "dir-skills:acme", reason: "the rules setting already has a rule with that name" },
    ]);
    expect(JSON.parse(h.state.rules).rules[0]).toEqual({ name: "dir-skills:acme", instructions: "mine" });
  });

  it("skips a setting scope named like a profile scope that profiles.json has", async () => {
    const h = harness({
      profiles: { scopes: [{ name: "acme", paths: ["/prof"], claudeConfigDir: "/profiles/acme" }] },
      ui: [scope()],
    });
    const out = await report(h);
    expect(out.settingScopes).toEqual([]);
    expect(out.rules).toEqual([]);
    expect(out.skipped[0]).toMatchObject({ kind: "scope", name: "acme" });
    expect(out.skipped[0].reason).toMatch(/would be ignored/);
  });

  it("fails the whole import, writing nothing, when the setting would be rejected", async () => {
    const full = { scopes: Array.from({ length: 32 }, (_, i) => ({ name: `s${i}`, paths: ["/p"] })), rules: [GUARD] };
    const h = harness({
      rules: JSON.stringify(full),
      scopes: { scopes: [profiled()] },
      ui: [scope()],
      pins: [{ threadId: "thr_1", pin: { dir: null, scope: null } }],
    });
    const result = await run(h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/the rules setting would be rejected \(nothing was written\):\n  /);
    expect(existsSync(h.files.profiles)).toBe(false);
    expect(h.state.sets).toEqual([]);
    expect(h.kv.size).toBe(0);
  });
});

describe("profile scopes", () => {
  it("are written only when profiles.json is absent, and their rules follow", async () => {
    const h = harness({ scopes: { scopes: [profiled(), profiled({ name: "second", skills: ["other"] })] } });
    const out = await report(h);
    expect(out.profilesFile).toBe("absent");
    expect(out.profileScopes.map((s) => s.name)).toEqual(["prof", "second"]);
    expect(out.settingScopes).toEqual([]);
    expect(out.rules.map((r) => r.scope)).toEqual(["prof", "second"]);
    expect(h.state.reloads).toBe(1);
  });

  it("never overwrite profiles.json: a different scope is listed as skipped and its rule is not imported", async () => {
    const before = { scopes: [{ name: "prof", paths: ["/other"], claudeConfigDir: "/profiles/other" }] };
    const h = harness({ profiles: before, scopes: { scopes: [profiled(), profiled({ name: "gone" })] } });
    const out = await report(h);
    expect(out.profilesFile).toBe("valid");
    expect(out.profileScopes).toEqual([]);
    expect(out.rules).toEqual([]);
    expect(out.skipped.map((s) => [s.kind, s.name, s.reason])).toEqual([
      ["profile-scope", "prof", "profiles.json already exists and is never overwritten"],
      ["profile-scope", "gone", "profiles.json already exists and is never overwritten"],
    ]);
    expect(JSON.parse(readFileSync(h.files.profiles, "utf8"))).toEqual(before);
    expect(h.state.reloads).toBe(0);
  });

  it("recognise a scope that profiles.json already has (a re-run), and still import its rule", async () => {
    const h = harness({ scopes: { scopes: [profiled()] } });
    await report(h);
    h.state.rules = "[]";
    const again = await report(h);
    expect(again.profileScopes).toEqual([]);
    expect(again.rules).toEqual([{ name: "dir-skills:prof", scope: "prof", skills: ["work-*"] }]);
    expect(again.skipped).toEqual([{ kind: "profile-scope", name: "prof", reason: "profiles.json already has this scope" }]);
  });

  it("are skipped, with no rule, while profiles.json is malformed; the file stays as it is", async () => {
    const h = harness({ profiles: "{", scopes: { scopes: [profiled()] } });
    const out = await report(h);
    expect(out.profilesFile).toBe("malformed");
    expect(out.rules).toEqual([]);
    expect(out.skipped[0].reason).toMatch(/malformed; fix or remove it/);
    expect(readFileSync(h.files.profiles, "utf8")).toBe("{");
  });

  it("stop the import when profiles.json cannot be written, before the setting or the pins", async () => {
    const h = harness({ scopes: { scopes: [profiled()] }, pins: [{ threadId: "thr_1", pin: { dir: null, scope: null } }] });
    const dir = path.dirname(h.files.profiles);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    let result;
    try {
      result = await run(h);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(result).toEqual({
      exitCode: 1,
      stderr: "import-dir-skills: could not write profiles.json (nothing else was written)\n",
    });
    expect(h.state.sets).toEqual([]);
    expect(h.kv.size).toBe(0);
  });

  it("stop the import when profiles.json appears after the plan was made", async () => {
    const h = harness({ scopes: { scopes: [profiled()] }, pins: [{ threadId: "thr_1", pin: { dir: null, scope: null } }] });
    const get = h.deps.kv.get;
    h.deps.kv.get = async <T,>(key: string) => {
      put(h.files.profiles, { scopes: [] });
      return get<T>(key);
    };
    const result = await run(h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/profiles\.json appeared while importing; nothing was written, run again/);
    expect(JSON.parse(readFileSync(h.files.profiles, "utf8"))).toEqual({ scopes: [] });
    expect(h.state.sets).toEqual([]);
    expect(h.kv.size).toBe(0);
  });

  it("leave a recoverable state when the setting is rejected after profiles.json was written", async () => {
    const h = harness({
      scopes: { scopes: [profiled()] },
      pins: [{ threadId: "thr_1", pin: { dir: null, scope: null } }],
      setError: "boom",
    });
    const result = await run(h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("the rules setting was rejected: boom");
    expect(result.stderr).toContain("profiles.json was written; run again to finish");
    expect(h.kv.size).toBe(0);
    expect(existsSync(h.files.profiles)).toBe(true);
  });

  it("report a rejected setting write with nothing written when there was no profile scope", async () => {
    const h = harness({ ui: [scope()], setError: "rejected" });
    const result = await run(h);
    expect(result.stderr).toBe("import-dir-skills: the rules setting was rejected: rejected\nnothing was written\n");
    const text = await importCommand({ ...h.deps, setRules: async () => { throw "plain"; } }, [], false);
    expect(text.stderr).toContain("was rejected: plain");
  });

  it("rethrow an error that is not an import failure", async () => {
    const h = harness({ ui: [scope()] });
    await expect(importCommand({ ...h.deps, getRules: async () => { throw new Error("storage down"); } }, [], false)).rejects.toThrow("storage down");
  });
});

describe("pins", () => {
  it("import a null pin and a pin for a profile dir, keep an existing pin, and reject the rest", async () => {
    const h = harness({
      scopes: { scopes: [profiled()] },
      kv: { "claude-config-dir:thr_have": { dir: "/old", scope: "old" } },
    });
    put(h.files.export, {
      uiScopes: [],
      pins: [
        { threadId: "thr_null", pin: { dir: null, scope: null } },
        { threadId: "thr_dir", pin: { dir: profDir(h), scope: "prof" } },
        { threadId: "thr_have", pin: { dir: null, scope: null } },
        { threadId: "thr_unknown", pin: { dir: "/somewhere/else", scope: "x" } },
        { threadId: "thr_dup", pin: { dir: null, scope: null } },
        { threadId: "thr_dup", pin: { dir: null, scope: null } },
        { threadId: "thr_shape", pin: { dir: 7, scope: null } },
        { threadId: "thr_extra", pin: { dir: null, scope: null, other: 1 } },
        { pin: { dir: null, scope: null } },
        "nonsense",
        null,
      ],
    });
    const out = await report(h);
    expect(out.pins.imported.map((p) => p.threadId)).toEqual(["thr_null", "thr_dir", "thr_dup"]);
    expect(out.pins.kept).toEqual(["thr_have"]);
    expect(out.pins.rejected.map((p) => [p.threadId, p.reason.split(":")[0]])).toEqual([
      ["thr_unknown", `dir /somewhere/else is not a claudeConfigDir in profiles.json`.split(":")[0]],
      ["thr_dup", "listed twice in ~/.bb/dir-skills/export.json"],
      ["thr_shape", "invalid pin"],
      ["thr_extra", "invalid pin"],
      ["(unknown)", "invalid pin"],
      ["(unknown)", "invalid pin"],
      ["(unknown)", "invalid pin"],
    ]);
    expect(h.kv.get("claude-config-dir:thr_have")).toEqual({ dir: "/old", scope: "old" });
    expect(h.kv.get("claude-config-dir:thr_dir")).toEqual({ dir: profDir(h), scope: "prof" });
    expect(h.kv.has("claude-config-dir:thr_unknown")).toBe(false);
    const text = formatImport({ ...out, dryRun: false });
    expect(text).toContain("thr_have: kept, a pin already exists");
    expect(text).toContain("thr_unknown: rejected, dir /somewhere/else is not a claudeConfigDir in profiles.json");
  });

  it("accept a dir that an existing profiles.json defines, and reject it while the file is absent or malformed", async () => {
    const dir = "/profiles/acme";
    const pins = [{ threadId: "thr_1", pin: { dir, scope: "acme" } }];
    const existing = harness({ profiles: { scopes: [{ name: "acme", paths: ["/a"], claudeConfigDir: dir }] }, pins });
    expect((await report(existing)).pins.imported).toHaveLength(1);
    for (const profiles of [undefined, "{"]) {
      const h = harness({ profiles, pins });
      const out = await report(h);
      expect(out.pins.imported).toEqual([]);
      expect(out.pins.rejected[0].reason).toContain("is not a claudeConfigDir in profiles.json");
    }
  });
});

describe("--dry-run", () => {
  it("prints the whole plan and writes nothing", async () => {
    const h = harness({
      scopes: { scopes: [profiled(), scope({ name: "plain" })] },
      ui: [scope({ name: "ui" })],
      pins: [{ threadId: "thr_1", pin: { dir: null, scope: null } }],
    });
    const before = h.state.rules;
    const result = await run(h, ["--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("import-dir-skills (dry run): nothing is written");
    expect(result.stdout).toContain("profiles.json (absent before): would write 1 scope(s): prof");
    expect(result.stdout).toContain("rules setting: would write 2 scope(s), 3 rule(s)");
    expect(result.stdout).toContain("pins: 1 to import, 0 kept, 0 rejected");
    expect(result.stdout).not.toContain("needs `bb model-instructions unpin");
    expect(existsSync(h.files.profiles)).toBe(false);
    expect(readdirSync(path.dirname(h.files.scopes)).sort()).toEqual(["export.json", "scopes.json"]);
    expect(h.state.rules).toBe(before);
    expect(h.state.sets).toEqual([]);
    expect(h.state.reloads).toBe(0);
    expect(h.kv.size).toBe(0);
    expect(h.state.logs).toEqual([]);
  });

  it("gives the same data as JSON, and a real run then does what the plan said", async () => {
    const h = harness({ scopes: { scopes: [profiled()] }, ui: [scope()], pins: [{ threadId: "thr_1", pin: { dir: null, scope: null } }] });
    const plan = await report(h, ["--dry-run"]);
    expect(plan.dryRun).toBe(true);
    const done = await report(h);
    expect(done.dryRun).toBe(false);
    expect({ ...done, dryRun: true }).toEqual(plan);
  });

  it("still validates: a setting that would be rejected fails the dry run too", async () => {
    const h = harness({ rules: "{", ui: [scope()] });
    expect((await run(h, ["--dry-run"])).exitCode).toBe(1);
  });
});
