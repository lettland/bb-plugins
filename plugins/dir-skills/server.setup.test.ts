import { chmodSync, readdirSync, statSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopesSnapshot } from "./rpc-contract";
import plugin from "./server";

const REMOTE = "https://git.example.com/acme/app.git";
const SERVER_HOST = "host_local";

let base: string;
let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dir-skills-server-")));
  home = path.join(base, "home");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(base, { recursive: true, force: true });
});

function acmeTree(): string {
  const profile = path.join(home, ".claude-acme");
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    path.join(profile, "settings.json"),
    JSON.stringify({
      extraKnownMarketplaces: {
        acme: {
          source: {
            source: "git",
            url: "git@git.example.com:acme/marketplace.git",
          },
        },
      },
    }),
  );
  const app = path.join(home, "src", "acme", "app");
  mkdirSync(path.join(app, ".git"), { recursive: true });
  writeFileSync(
    path.join(app, ".git", "config"),
    `[remote "origin"]\n\turl = ${REMOTE}\n`,
  );
  return app;
}

interface LoadOptions {
  /** Pre-seeded plugin kv, as if saved before this load. */
  kv?: Record<string, unknown>;
  /** What the host returns as the plugin's own stored settings values; absent: the lookup fails. */
  own?: Record<string, unknown>;
}

async function load(app: string, options: LoadOptions = {}) {
  const host = createFakePluginHost({
    pluginId: "dir-skills",
    agentSkillIds: ["work-conventions"],
    sdk: {
      plugins: {
        getSettings: async ({ pluginId }: { pluginId: string }) => {
          if (pluginId === "dir-skills" && options.own !== undefined) {
            return { values: options.own };
          }
          if (pluginId !== "provider-acp") throw new Error("404");
          return {
            values: {
              customAgents: JSON.stringify([
                { id: "claude-acme", env: { CLAUDE_CONFIG_DIR: "~/.claude-acme" } },
              ]),
            },
          };
        },
      },
      projects: {
        list: async () => [
          {
            id: "proj_app",
            gitRemoteUrl: REMOTE,
            sources: [{ path: app, hostId: SERVER_HOST }],
          },
        ],
      },
      threads: {
        get: async () => ({ projectId: "proj_app" }),
      },
    },
  });
  for (const [key, value] of Object.entries(options.kv ?? {})) {
    await host.bb.storage.kv.set(key, value);
  }
  await plugin(host.bb);
  return host;
}

const env = (threadId: string) => ({
  threadId,
  projectId: "proj_app",
  hostId: SERVER_HOST,
});

describe("automatic setup on install", () => {
  it("registers an install handler and applies the new scope without a reload", async () => {
    const app = acmeTree();
    const host = await load(app);
    const { harness } = host;

    const before = await harness.runCli(["check", app, "--project", "proj_app"]);
    expect(before.stdout).not.toContain("work-conventions");
    expect(await harness.resolveProviderEnv("claude-code", env("thr_before"))).toEqual([]);

    await harness.install();

    const userFile = path.join(home, ".bb", "dir-skills", "scopes.json");
    expect(JSON.parse(readFileSync(userFile, "utf8"))).toEqual({
      scopes: [
        {
          name: "work",
          paths: ["~/src/acme"],
          skills: ["work-*"],
          claudeConfigDir: "~/.claude-acme",
        },
      ],
    });

    const after = await harness.runCli(["check", app, "--project", "proj_app"]);
    expect(after.stdout).toContain("work-conventions");
    expect(after.stdout).toContain(path.join(home, ".claude-acme"));

    const configured = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        project: { id: "proj_app" },
        environment: { path: app },
      }),
    );
    expect(configured.skills).toContain("work-conventions");

    expect(await harness.resolveProviderEnv("claude-code", env("thr_after"))).toEqual([
      expect.objectContaining({
        name: "CLAUDE_CONFIG_DIR",
        value: path.join(home, ".claude-acme"),
      }),
    ]);
    expect(await harness.resolveProviderEnv("claude-code", env("thr_before"))).toEqual([]);

    const status = await harness.runCli(["status"]);
    expect(status.stdout).toContain("auto-setup: wrote");
    expect(status.stdout).toContain("work: ~/src/acme".replace("~", home));
  });

  it("lets a thread pinned to the default profile pick up the new scope after unpin", async () => {
    const app = acmeTree();
    const { harness } = await load(app);
    await harness.resolveProviderEnv("claude-code", env("thr_before"));
    await harness.install();
    const unpin = await harness.runCli(["unpin", "thr_before"]);
    expect(unpin.exitCode).toBe(0);
    expect(await harness.resolveProviderEnv("claude-code", env("thr_before"))).toEqual([
      expect.objectContaining({ name: "CLAUDE_CONFIG_DIR" }),
    ]);
  });

  it("leaves scopes alone and reports the reason when nothing matches", async () => {
    const app = acmeTree();
    rmSync(path.join(home, ".claude-acme", "settings.json"));
    const { harness } = await load(app);
    await harness.install();
    const status = await harness.runCli(["status"]);
    expect(status.stdout).toContain("auto-setup: skipped (no-self-hosted-marketplace)");
    const setup = await harness.runCli(["setup", "--dry-run", "--json"]);
    expect(setup.exitCode).toBe(2);
    expect(JSON.parse(setup.stdout)).toMatchObject({
      outcome: "skipped",
      reason: "no-self-hosted-marketplace",
    });
  });

  it("does not touch an existing user file", async () => {
    const app = acmeTree();
    const userFile = path.join(home, ".bb", "dir-skills", "scopes.json");
    mkdirSync(path.dirname(userFile), { recursive: true });
    writeFileSync(userFile, JSON.stringify({ scopes: [{ name: "mine", paths: ["~/x"], skills: ["mine-*"] }] }));
    const { harness } = await load(app);
    await harness.install();
    expect((await harness.runCli(["status"])).stdout).toContain("auto-setup: skipped (exists)");
    const dry = JSON.parse((await harness.runCli(["setup", "--dry-run", "--json"])).stdout);
    expect(dry).toMatchObject({ outcome: "dry-run", reason: "exists" });
    expect(dry.candidate.name).toBe("work");
  });

  it("runs the same detection from `bb dir-skills setup`", async () => {
    const app = acmeTree();
    const { harness } = await load(app);
    const result = await harness.runCli(["setup", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).outcome).toBe("wrote");
    expect((await harness.runCli(["setup"])).exitCode).toBe(2);
  });

  it("lists setup among the commands", async () => {
    const { harness } = await load(acmeTree());
    expect(harness.registrations.cli?.commands.map((c) => c.name)).toContain("setup");
  });
});

const pluginDir = path.dirname(fileURLToPath(import.meta.url));

async function loadSdk(
  sdk: NonNullable<Parameters<typeof createFakePluginHost>[0]>["sdk"],
) {
  const host = createFakePluginHost({
    pluginId: "dir-skills",
    agentSkillIds: ["work-conventions"],
    sdk,
  });
  await plugin(host.bb);
  return host;
}

function failingListStub(throwValue: unknown) {
  return {
    plugins: {
      getSettings: async () => ({ values: {} }),
    },
    projects: {
      list: async () => {
        throw throwValue;
      },
    },
    threads: {
      get: async () => ({ projectId: "proj_app" }),
    },
  };
}

describe("cli surface", () => {
  it("serves status as json before any setup", async () => {
    const { harness } = await load(acmeTree());
    const result = await harness.runCli(["status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      root: pluginDir,
      userScopesFile: path.join(home, ".bb", "dir-skills", "scopes.json"),
      userScopesLoaded: false,
      settingScopes: 0,
      settingError: null,
      settingSkipped: [],
      autoSetup: null,
      scopes: [
        {
          name: "work",
          paths: [path.join(home, "workspace", "work")],
          skills: ["work-*"],
          claudeConfigDir: null,
        },
      ],
      skills: [{ name: "work-conventions", scopes: ["work"] }],
    });
  });

  it("lists text status before setup without profile or auto-setup lines", async () => {
    const { harness } = await load(acmeTree());
    const out = (await harness.runCli(["status"])).stdout;
    expect(out).toContain(
      `work: ${path.join(home, "workspace", "work")}  ->  work-*\n`,
    );
    expect(out).not.toContain("[claude profile");
    expect(out).toContain("work-conventions  [work]");
    expect(out).not.toContain("auto-setup:");
    expect(out).toContain("ui scopes: 0 (settings form)\n");
  });

  it("rejects check without a target", async () => {
    const { harness } = await load(acmeTree());
    const result = await harness.runCli(["check"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(
      "check: give a path, or run from inside a bb thread\n",
    );
  });

  it("falls back to the cli context for check", async () => {
    const app = acmeTree();
    const { harness } = await load(app);
    await harness.install();
    const withCtx = await harness.runCli(["check"], {
      cwd: app,
      projectId: "proj_app",
      threadId: "thr_ctx",
    });
    expect(withCtx.exitCode).toBe(0);
    expect(withCtx.stdout).toContain(`path: ${app}  (project proj_app)`);
    expect(withCtx.stdout).toContain("work-conventions");
    expect(withCtx.stdout).toContain(
      "pinned for thread thr_ctx: not pinned yet",
    );

    const byCwd = await harness.runCli(["check"], { cwd: app });
    expect(byCwd.exitCode).toBe(0);
    expect(byCwd.stdout).toContain(`path: ${app}\n`);
    expect(byCwd.stdout).not.toContain("(project");
    expect(byCwd.stdout).toContain("skills:\n  work-conventions");
  });

  it("serves check as json with the thread pin", async () => {
    const app = acmeTree();
    const { harness } = await load(app);
    await harness.install();
    const result = await harness.runCli(
      ["check", app, "--project", "proj_app", "--json"],
      { threadId: "thr_j" },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      path: app,
      projectId: "proj_app",
      skills: ["work-conventions"],
      claudeProfile: {
        status: "profile",
        dir: path.join(home, ".claude-acme"),
        scope: "work",
        conflict: [],
      },
      threadId: "thr_j",
      pinned: null,
    });
  });

  it("reports no skills and an unknown project for a project without checkouts", async () => {
    const app = acmeTree();
    const { harness } = await load(app);
    const result = await harness.runCli(["check", app, "--project", "proj_missing"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("skills: none");
    expect(result.stdout).toContain(
      "Claude profile (by project checkout, all hosts): unknown project",
    );
    expect(result.stdout).toContain("run `bb dir-skills unpin <thread-id>`");
  });

  it("rejects unknown commands", async () => {
    const { harness } = await load(acmeTree());
    const result = await harness.runCli(["bogus"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown command "bogus"');
  });

  it("defaults to status without a command", async () => {
    const { harness } = await load(acmeTree());
    const result = await harness.runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("scopes:");
  });

  it("checks a bare path without a project", async () => {
    const app = acmeTree();
    const { harness } = await load(app);
    await harness.install();
    const result = await harness.runCli(["check", app]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`path: ${app}\n`);
    expect(result.stdout).toContain("skills:\n  work-conventions");
    expect(result.stdout).toContain("Claude profile: needs --project");
  });

  it("treats a trailing --project without a value as absent", async () => {
    const app = acmeTree();
    const { harness } = await load(app);
    await harness.install();
    const result = await harness.runCli(["check", app, "--project"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`path: ${app}\n`);
    expect(result.stdout).not.toContain("(project");
    expect(result.stdout).toContain("Claude profile: needs --project");
  });
});

describe("export", () => {
  const exportPath = () => path.join(home, ".bb", "dir-skills", "export.json");
  const uiScope = (app: string) => ({ name: "ui", paths: [app], skills: ["work-*"] });
  const pin = (dir: string | null) => ({ dir, scope: dir === null ? null : "work" });

  it("is listed with its usage and named in the unknown-command hint", async () => {
    const { harness } = await load(acmeTree());
    expect(harness.registrations.cli?.commands.find((c) => c.name === "export")).toMatchObject({
      summary: "Write UI scopes and Claude profile pins to ~/.bb/dir-skills/export.json",
      usage: "bb dir-skills export [--json]",
    });
    expect((await harness.runCli(["bogus"])).stderr).toContain("| unpin [<thread-id>] | export\n");
  });

  it("writes the UI scopes and the pins sorted by thread id, mode 0600", async () => {
    const app = acmeTree();
    const scopes = [uiScope(app)];
    const { harness, bb } = await load(app, {
      kv: {
        uiScopes: scopes,
        "claude-config-dir:thr_b": pin("/p/b"),
        "claude-config-dir:thr_a": pin(null),
        "unrelated-key": { dir: "/nope" },
      },
    });
    const result = await harness.runCli(["export"]);
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: `wrote ${exportPath()}: 1 UI scope(s), 2 pin(s)\n`,
    });
    const text = readFileSync(exportPath(), "utf8");
    expect(text).toBe(
      JSON.stringify(
        {
          uiScopes: scopes,
          pins: [
            { threadId: "thr_a", pin: pin(null) },
            { threadId: "thr_b", pin: pin("/p/b") },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    expect(statSync(exportPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(exportPath()))).toEqual(["export.json"]);
    expect(await bb.storage.kv.get("uiScopes")).toEqual(scopes);
  });

  it("prints json with the counts", async () => {
    const app = acmeTree();
    const { harness } = await load(app, {
      kv: { uiScopes: [uiScope(app)], "claude-config-dir:thr_a": pin(null) },
    });
    const result = await harness.runCli(["export", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      JSON.stringify({ path: exportPath(), status: "wrote", uiScopes: 1, pins: 1 }, null, 2) + "\n",
    );
  });

  it("writes empty lists when nothing is stored", async () => {
    const { harness } = await load(acmeTree());
    const result = await harness.runCli(["export"]);
    expect(result.stdout).toBe(`wrote ${exportPath()}: 0 UI scope(s), 0 pin(s)\n`);
    expect(JSON.parse(readFileSync(exportPath(), "utf8"))).toEqual({ uiScopes: [], pins: [] });
  });

  it("writes no UI scopes while the stored value is ignored", async () => {
    const { harness } = await load(acmeTree(), { kv: { uiScopes: "not an array" } });
    expect(((await harness.callRpc("getScopes", null)) as ScopesSnapshot).settingError).not.toBeNull();
    const result = await harness.runCli(["export"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(exportPath(), "utf8"))).toEqual({ uiScopes: [], pins: [] });
  });

  it("does not replace an existing file", async () => {
    const { harness } = await load(acmeTree());
    mkdirSync(path.dirname(exportPath()), { recursive: true });
    writeFileSync(exportPath(), "mine");
    const plain = await harness.runCli(["export"]);
    expect(plain).toMatchObject({
      exitCode: 1,
      stderr: `export: ${exportPath()} already exists; move it away and run again\n`,
    });
    const json = await harness.runCli(["export", "--json"]);
    expect(json).toMatchObject({
      exitCode: 1,
      stdout: JSON.stringify({ path: exportPath(), status: "exists" }, null, 2) + "\n",
    });
    expect(json.stderr ?? "").toBe("");
    expect(plain.stdout ?? "").toBe("");
    expect(readFileSync(exportPath(), "utf8")).toBe("mine");
    expect(readdirSync(path.dirname(exportPath()))).toEqual(["export.json"]);
  });

  it("reports a fixed error when the file cannot be written", async () => {
    const { harness } = await load(acmeTree());
    mkdirSync(path.join(home, ".bb"), { recursive: true });
    writeFileSync(path.join(home, ".bb", "dir-skills"), "a file, not a directory");
    for (const flags of [[], ["--json"]]) {
      expect(await harness.runCli(["export", ...flags])).toMatchObject({
        exitCode: 1,
        stderr: `export: could not write ${exportPath()}\n`,
      });
    }
  });

  it("changes no stored data, setting or scope", async () => {
    const app = acmeTree();
    const kv = { uiScopes: [uiScope(app)], "claude-config-dir:thr_a": pin(null) };
    const { harness, bb } = await load(app, { kv });
    const before = await harness.callRpc("getScopes", null);
    await harness.runCli(["export"]);
    expect(await harness.callRpc("getScopes", null)).toEqual(before);
    expect(await bb.storage.kv.get("uiScopes")).toEqual(kv.uiScopes);
    expect(await bb.storage.kv.list("")).toEqual(expect.arrayContaining(Object.keys(kv)));
  });
});

describe("Scopes form", () => {
  type Harness = Awaited<ReturnType<typeof load>>["harness"];
  const skillsRoot = path.join(pluginDir, "skills");
  const userFilePath = () => path.join(home, ".bb", "dir-skills", "scopes.json");
  const writeUserFile = (scopes: unknown[]) => {
    mkdirSync(path.dirname(userFilePath()), { recursive: true });
    writeFileSync(userFilePath(), JSON.stringify({ scopes }));
    return userFilePath();
  };
  const profiled = (app: string) => ({
    name: "work",
    paths: [app],
    skills: ["work-*"],
    claudeConfigDir: "~/.claude-acme",
  });
  const scopeOf = (app: string, over: Record<string, unknown> = {}) => ({
    name: "ui",
    paths: [app],
    skills: ["work-*"],
    ...over,
  });
  const getScopes = (harness: Harness) =>
    harness.callRpc("getScopes", null) as Promise<ScopesSnapshot>;
  const saveScopes = (harness: Harness, scopes: unknown[]) =>
    harness.callRpc("saveScopes", { scopes }) as Promise<ScopesSnapshot>;
  const status = async (harness: Harness) =>
    JSON.parse((await harness.runCli(["status", "--json"])).stdout);
  const check = async (harness: Harness, app: string) =>
    (await harness.runCli(["check", app, "--project", "proj_app"])).stdout;
  const warning = (name: string) =>
    `UI scopes: scope "${name}" ignored: a scope with a Claude profile can only be changed in ~/.bb/dir-skills/scopes.json`;

  it("no longer defines a setting", async () => {
    const { harness } = await load(acmeTree());
    expect(harness.registrations.settingsDescriptors).toEqual({});
  });

  it("registers getScopes and saveScopes", async () => {
    const { harness } = await load(acmeTree());
    expect(harness.registrations.rpcMethods.sort()).toEqual(["getScopes", "saveScopes"]);
  });

  describe("getScopes", () => {
    it("returns the file scopes, the skills and no stored scopes at first", async () => {
      const app = acmeTree();
      const { harness } = await load(app);
      const snapshot = await getScopes(harness);
      expect(snapshot).toEqual({
        fileScopes: [
          {
            name: "work",
            paths: [path.join(home, "workspace", "work")],
            skills: ["work-*"],
            source: "shipped",
            hasProfile: false,
            replacedByUi: false,
          },
        ],
        uiScopes: [],
        skills: [
          {
            name: "work-conventions",
            description: expect.stringMatching(/^Placeholder work skill/),
          },
        ],
        skipped: [],
        settingError: null,
      });
    });

    it("tags sources, profiles and replaced scopes, and returns stored scopes as saved", async () => {
      const app = acmeTree();
      writeUserFile([
        { name: "mine", paths: ["/mine"], skills: ["mine-*"] },
        { name: "kept", paths: ["/kept"], skills: ["kept-*"], claudeConfigDir: "/opt/claude" },
      ]);
      const stored = [{ name: "mine", paths: ["~/ui", "/abs"], skills: ["a", "b-*"] }];
      const { harness } = await load(app, { kv: { uiScopes: stored } });
      const snapshot = await getScopes(harness);
      expect(snapshot.fileScopes).toEqual([
        {
          name: "work",
          paths: [path.join(home, "workspace", "work")],
          skills: ["work-*"],
          source: "shipped",
          hasProfile: false,
          replacedByUi: false,
        },
        {
          name: "mine",
          paths: ["/mine"],
          skills: ["mine-*"],
          source: "file",
          hasProfile: false,
          replacedByUi: true,
        },
        {
          name: "kept",
          paths: ["/kept"],
          skills: ["kept-*"],
          source: "file",
          hasProfile: true,
          replacedByUi: false,
        },
      ]);
      expect(snapshot.uiScopes).toEqual(stored);
      expect(JSON.stringify(snapshot)).not.toContain("/opt/claude");
    });

    it("gives one entry for a name in both files, tagged file, with its profile", async () => {
      const app = acmeTree();
      writeUserFile([profiled(app)]);
      const { harness } = await load(app);
      const snapshot = await getScopes(harness);
      expect(snapshot.fileScopes).toEqual([
        {
          name: "work",
          paths: [app],
          skills: ["work-*"],
          source: "file",
          hasProfile: true,
          replacedByUi: false,
        },
      ]);
      expect(JSON.stringify(snapshot)).not.toContain(".claude-acme");
    });

    it("lists skills with and without a description, reading single-line frontmatter", async () => {
      const made: string[] = [];
      const add = (entry: string, body: string) => {
        const dir = path.join(skillsRoot, entry);
        mkdirSync(dir);
        made.push(dir);
        writeFileSync(path.join(dir, "SKILL.md"), body);
      };
      try {
        add("zz-fixture-plain-desc", "---\nname: zz-plain\ndescription: Plain words\n---\nbody");
        add("zz-fixture-quoted", '---\nname: "zz-quoted"\ndescription: "Quoted words"\n---\nbody');
        add("zz-fixture-none", "---\nname: zz-none\n---\nbody");
        add("zz-fixture-nofront", "no frontmatter");
        const { harness } = await load(acmeTree());
        const names = (await getScopes(harness)).skills;
        expect(names).toEqual([
          { name: "work-conventions", description: expect.stringMatching(/^Placeholder/) },
          { name: "zz-fixture-nofront", description: "" },
          { name: "zz-none", description: "" },
          { name: "zz-plain", description: "Plain words" },
          { name: "zz-quoted", description: "Quoted words" },
        ]);
      } finally {
        for (const dir of made) rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("saveScopes", () => {
    it("stores a scope as saved, makes it active and keeps it after a reload", async () => {
      const app = acmeTree();
      const host = await load(app);
      const { harness } = host;
      expect(await check(harness, app)).not.toContain("work-conventions");
      const scopes = [scopeOf("~/ui-dir")];
      scopes[0].paths = [app, " ~/ui-dir "];
      const saved = await saveScopes(harness, scopes);
      expect(saved.uiScopes).toEqual(scopes);
      expect(saved.settingError).toBeNull();
      expect(await host.bb.storage.kv.get("uiScopes")).toEqual(scopes);
      expect(await check(harness, app)).toContain("work-conventions");
      expect(await status(harness)).toMatchObject({ settingScopes: 1, settingError: null });
      expect((await harness.runCli(["status"])).stdout).toContain(
        "ui scopes: 1 (settings form)\n",
      );
      const configured = await harness.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({
          project: { id: "proj_app" },
          environment: { path: app },
        }),
      );
      expect(configured.skills).toContain("work-conventions");

      const reloaded = await harness.lifecycle.reload(plugin);
      expect((await getScopes(reloaded.harness)).uiScopes).toEqual(scopes);
      expect(await check(reloaded.harness, app)).toContain("work-conventions");
    });

    it("applies a change and a clear without a reload", async () => {
      const app = acmeTree();
      const { harness } = await load(app);
      await saveScopes(harness, [scopeOf(app)]);
      expect(await check(harness, app)).toContain("work-conventions");
      await saveScopes(harness, []);
      expect(await check(harness, app)).not.toContain("work-conventions");
      expect(await status(harness)).toMatchObject({ settingScopes: 0, settingError: null });
    });

    it.each<[string, unknown[], RegExp]>([
      ["a relative path", [scopeOf("src/acme")], /every directory must be absolute or start with "~\/"/],
      ["an empty name", [scopeOf("/a", { name: " " })], /scope 1 needs a name/],
      ["a duplicate name", [scopeOf("/a"), scopeOf("/b", { name: "ui " })], /the name is used twice/],
      ["a control character", [scopeOf("/a", { name: "a\nb" })], /control characters/],
      ["an empty skills list", [scopeOf("/a", { skills: [] })], /needs at least one skill/],
      ["an empty skill", [scopeOf("/a", { skills: [" "] })], /needs at least one skill/],
      ["an empty path list", [scopeOf("/a", { paths: [] })], /needs at least one directory/],
      ["a claudeConfigDir", [scopeOf("/a", { claudeConfigDir: "/opt/claude" })], /rpc input validation failed/],
      ["too many scopes", Array.from({ length: 33 }, (_, i) => scopeOf("/a", { name: `s${i}` })), /rpc input validation failed/],
    ])("stores nothing for %s", async (_label, scopes, message) => {
      const app = acmeTree();
      const host = await load(app);
      const before = await status(host.harness);
      await expect(saveScopes(host.harness, scopes)).rejects.toThrow(message);
      expect(await host.bb.storage.kv.get("uiScopes")).toBeUndefined();
      expect(await status(host.harness)).toEqual(before);
      expect((await getScopes(host.harness)).uiScopes).toEqual([]);
    });

    it("leaves the stored scopes and the state alone when the user file is broken", async () => {
      const app = acmeTree();
      const userFile = writeUserFile([{ name: "mine", paths: ["/mine"], skills: ["mine-*"] }]);
      const host = await load(app, { kv: { uiScopes: [scopeOf(app, { name: "old" })] } });
      const before = await status(host.harness);
      writeFileSync(userFile, "{ not json");
      await expect(saveScopes(host.harness, [scopeOf(app, { name: "new" })])).rejects.toThrow(
        `${userFile}: not valid JSON`,
      );
      expect(await host.bb.storage.kv.get("uiScopes")).toEqual([scopeOf(app, { name: "old" })]);
      expect(await status(host.harness)).toEqual(before);
      expect((await getScopes(host.harness)).uiScopes).toEqual([scopeOf(app, { name: "old" })]);
    });

    it("stores nothing when skills cannot be loaded", async () => {
      const app = acmeTree();
      const host = await load(app);
      const before = await status(host.harness);
      const mode = statSync(skillsRoot).mode & 0o7777;
      chmodSync(skillsRoot, 0o000);
      try {
        await expect(saveScopes(host.harness, [scopeOf(app)])).rejects.toThrow(/EACCES/);
      } finally {
        chmodSync(skillsRoot, mode);
      }
      expect(await host.bb.storage.kv.get("uiScopes")).toBeUndefined();
      expect(await status(host.harness)).toEqual(before);
      expect(await check(host.harness, app)).not.toContain("work-conventions");
    });

    it("keeps the state when the store write fails", async () => {
      const app = acmeTree();
      const host = await load(app);
      const before = await status(host.harness);
      const set = vi.spyOn(host.bb.storage.kv, "set").mockRejectedValueOnce(new Error("disk full"));
      await expect(saveScopes(host.harness, [scopeOf(app)])).rejects.toThrow(/disk full/);
      set.mockRestore();
      expect(await status(host.harness)).toEqual(before);
      expect((await getScopes(host.harness)).uiScopes).toEqual([]);
    });

    it("finishes overlapping saves in order, one at a time", async () => {
      const app = acmeTree();
      const host = await load(app);
      const events: string[] = [];
      const kv = host.bb.storage.kv;
      const realSet = kv.set.bind(kv);
      vi.spyOn(kv, "set").mockImplementation(async (key, value) => {
        const name = (value as Array<{ name: string }>)[0].name;
        events.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, name === "first" ? 30 : 0));
        await realSet(key, value);
        events.push(`end ${name}`);
      });
      const first = saveScopes(host.harness, [scopeOf(app, { name: "first" })]);
      const second = saveScopes(host.harness, [scopeOf(app, { name: "second" })]);
      const [one, two] = await Promise.all([first, second]);
      vi.restoreAllMocks();
      expect(events).toEqual(["start first", "end first", "start second", "end second"]);
      expect(one.uiScopes[0].name).toBe("first");
      expect(two.uiScopes[0].name).toBe("second");
      expect((await getScopes(host.harness)).uiScopes[0].name).toBe("second");
    });

    it("saves after a failed save", async () => {
      const app = acmeTree();
      const { harness } = await load(app);
      const bad = saveScopes(harness, [scopeOf("relative")]);
      const good = saveScopes(harness, [scopeOf(app)]);
      await expect(bad).rejects.toThrow(/absolute/);
      expect((await good).uiScopes).toEqual([scopeOf(app)]);
      expect(await check(harness, app)).toContain("work-conventions");
    });
  });

  describe("a UI scope named like a file scope", () => {
    const setup = async (userScopes: unknown[]) => {
      const app = acmeTree();
      const elsewhere = path.join(home, "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      writeUserFile(userScopes.length === 0 ? [profiled(app)] : userScopes);
      const host = await load(app);
      return { app, elsewhere, host };
    };

    it("is skipped, warned about and listed when the file scope has a profile", async () => {
      const { app, elsewhere, host } = await setup([]);
      const { harness } = host;
      const saved = await saveScopes(harness, [
        { name: "work", paths: [elsewhere], skills: ["other-*"] },
      ]);
      expect(saved.skipped).toEqual(["work"]);
      expect(saved.fileScopes[0]).toMatchObject({ hasProfile: true, replacedByUi: false });
      expect(saved.uiScopes).toHaveLength(1);
      expect(harness.logEntries).toContainEqual(
        expect.objectContaining({ level: "warn", message: warning("work") }),
      );
      const json = await status(harness);
      expect(json.settingSkipped).toEqual(["work"]);
      expect(json.scopes.find((s: { name: string }) => s.name === "work")).toEqual({
        name: "work",
        paths: [app],
        skills: ["work-*"],
        claudeConfigDir: path.join(home, ".claude-acme"),
      });
      expect((await harness.runCli(["status"])).stdout).toContain(
        "ui scopes: 1 (settings form)\nui scopes skipped (profile scopes are file-only): work\n",
      );
      expect(await harness.resolveProviderEnv("claude-code", env("thr_file"))).toEqual([
        expect.objectContaining({
          name: "CLAUDE_CONFIG_DIR",
          value: path.join(home, ".claude-acme"),
        }),
      ]);
    });

    it("lists every skipped name and clears the list on the next save", async () => {
      const app = acmeTree();
      writeUserFile([
        profiled(app),
        { name: "second", paths: [app], skills: ["x-*"], claudeConfigDir: "~/.claude-acme" },
      ]);
      const { harness } = await load(app);
      const entry = (name: string) => ({ name, paths: [app], skills: ["x-*"] });
      expect((await saveScopes(harness, [entry("work"), entry("second")])).skipped).toEqual([
        "work",
        "second",
      ]);
      expect((await harness.runCli(["status"])).stdout).toContain(
        "ui scopes skipped (profile scopes are file-only): work, second\n",
      );
      expect((await saveScopes(harness, [entry("fresh")])).skipped).toEqual([]);
      expect((await harness.runCli(["status"])).stdout).not.toContain("ui scopes skipped");
    });

    it("replaces a file scope without a profile and is not skipped", async () => {
      const app = acmeTree();
      writeUserFile([{ name: "work", paths: [app], skills: ["work-*"] }]);
      const { harness } = await load(app);
      const saved = await saveScopes(harness, [
        { name: "work", paths: [app], skills: ["other-*"] },
      ]);
      expect(saved.skipped).toEqual([]);
      expect(saved.fileScopes[0]).toMatchObject({ hasProfile: false, replacedByUi: true });
      const json = await status(harness);
      expect(json.settingSkipped).toEqual([]);
      expect(json.scopes.find((s: { name: string }) => s.name === "work")).toMatchObject({
        skills: ["other-*"],
        claudeConfigDir: null,
      });
      expect(harness.logEntries).not.toContainEqual(
        expect.objectContaining({ message: warning("work") }),
      );
      expect((await harness.runCli(["status"])).stdout).not.toContain("ui scopes skipped");
    });
  });

  describe("a stored value that cannot be used at startup", () => {
    it.each<[string, unknown, RegExp]>([
      ["a wrong shape", { scopes: [] }, /wrong shape/],
      ["a stored claudeConfigDir", [scopeOf("/a", { claudeConfigDir: "/opt/claude" })], /wrong shape/],
      ["a relative path", [scopeOf("src/acme")], /every directory must be absolute/],
    ])("ignores %s, reports it and clears it on the next save", async (_label, stored, message) => {
      const app = acmeTree();
      writeUserFile([{ name: "mine", paths: ["/mine"], skills: ["mine-*"] }]);
      const { harness } = await load(app, { kv: { uiScopes: stored } });
      const snapshot = await getScopes(harness);
      expect(snapshot.uiScopes).toEqual([]);
      expect(snapshot.settingError).toMatch(message);
      expect(harness.logEntries).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: `Stored UI scopes ignored: ${snapshot.settingError}`,
        }),
      );
      const json = await status(harness);
      expect(json.settingScopes).toBe(0);
      expect(json.settingError).toBe(snapshot.settingError);
      expect(json.scopes.map((s: { name: string }) => s.name).sort()).toEqual(["mine", "work"]);
      expect((await harness.runCli(["status"])).stdout).toContain(
        `ui scopes: ignored — ${snapshot.settingError}\n`,
      );

      const saved = await saveScopes(harness, [scopeOf(app)]);
      expect(saved.settingError).toBeNull();
      expect(await status(harness)).toMatchObject({ settingScopes: 1, settingError: null });
    });

    it("keeps a stored empty list as is", async () => {
      const { harness } = await load(acmeTree(), { kv: { uiScopes: [] }, own: { scopes: "x" } });
      expect(await getScopes(harness)).toMatchObject({ uiScopes: [], settingError: null });
    });
  });

  describe("one-time import of the removed Scopes setting", () => {
    const legacy = (app: string, over: Record<string, unknown> = {}) =>
      JSON.stringify({ scopes: [scopeOf(app, over)] });
    const imported = (message: string) =>
      expect.objectContaining({ level: "info", message });

    it("imports a stored value when the store is empty, and logs it", async () => {
      const app = acmeTree();
      const scope = scopeOf(app, { paths: [app, "~/ui"] });
      const host = await load(app, { own: { scopes: JSON.stringify({ scopes: [scope] }) } });
      expect(await host.bb.storage.kv.get("uiScopes")).toEqual([scope]);
      expect((await getScopes(host.harness)).uiScopes).toEqual([scope]);
      expect(host.harness.logEntries).toContainEqual(
        imported("imported 1 scope(s) from the removed Scopes setting"),
      );
      expect(await check(host.harness, app)).toContain("work-conventions");
    });

    it("does not overwrite a stored value", async () => {
      const app = acmeTree();
      const stored = [scopeOf(app, { name: "kept" })];
      const host = await load(app, { kv: { uiScopes: stored }, own: { scopes: legacy(app) } });
      expect(await host.bb.storage.kv.get("uiScopes")).toEqual(stored);
      expect((await getScopes(host.harness)).uiScopes).toEqual(stored);
      expect(host.harness.logEntries).not.toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("removed Scopes setting") }),
      );
    });

    it("imports nothing when the lookup fails, or the key is absent, not a string or blank", async () => {
      const app = acmeTree();
      for (const own of [undefined, {}, { scopes: 5 }, { scopes: null }, { scopes: "" }, { scopes: "  \n" }]) {
        const host = await load(app, own === undefined ? {} : { own });
        expect(await host.bb.storage.kv.get("uiScopes")).toBeUndefined();
        expect((await getScopes(host.harness)).uiScopes).toEqual([]);
        expect(host.harness.logEntries).not.toContainEqual(
          expect.objectContaining({ message: expect.stringContaining("removed Scopes setting") }),
        );
      }
    });

    it.each<[string, (app: string) => string, string]>([
      ["malformed JSON", () => "{", "not valid JSON"],
      ["a null root", () => "null", "expected"],
      ["a missing scopes key", () => "{}", "expected"],
      ["a claudeConfigDir", (app) => legacy(app, { claudeConfigDir: "/opt/claude" }), "expected"],
      ["a relative path", () => legacy("rel"), "every directory must be absolute"],
    ])("imports nothing for %s and says why", async (_label, text, why) => {
      const app = acmeTree();
      const host = await load(app, { own: { scopes: text(app) } });
      expect(await host.bb.storage.kv.get("uiScopes")).toBeUndefined();
      expect((await getScopes(host.harness)).uiScopes).toEqual([]);
      expect(host.harness.logEntries).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: expect.stringMatching(
            new RegExp(`^the removed Scopes setting was not imported: .*${why}`),
          ),
        }),
      );
    });

    it("imports nothing when the store write fails, and says so", async () => {
      const app = acmeTree();
      const host = createFakePluginHost({
        pluginId: "dir-skills",
        agentSkillIds: ["work-conventions"],
        sdk: {
          plugins: { getSettings: async () => ({ values: { scopes: legacy(app) } }) },
          projects: { list: async () => [] },
        },
      });
      vi.spyOn(host.bb.storage.kv, "set").mockRejectedValueOnce(new Error("disk full"));
      await plugin(host.bb);
      vi.restoreAllMocks();
      expect((await getScopes(host.harness)).uiScopes).toEqual([]);
      expect(host.harness.logEntries).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "the removed Scopes setting was not imported: disk full",
        }),
      );
    });
  });

  it("serves the form state in status json and text", async () => {
    const app = acmeTree();
    const { harness } = await load(app, { kv: { uiScopes: [scopeOf(app)] } });
    expect(await status(harness)).toMatchObject({
      settingScopes: 1,
      settingError: null,
      settingSkipped: [],
    });
    expect(await status(harness)).not.toHaveProperty("settingReloadError");
    expect((await harness.runCli(["status"])).stdout).toContain("ui scopes: 1 (settings form)\n");
  });
});

describe("skill discovery edges", () => {
  const skillsRoot = path.join(pluginDir, "skills");
  const created: string[] = [];

  function add(entry: string, make: (p: string) => void): void {
    const p = path.join(skillsRoot, entry);
    make(p);
    created.push(p);
  }

  afterAll(() => {
    for (const p of created) rmSync(p, { recursive: true, force: true });
  });

  it("skips unreadable and file entries, naming the rest by frontmatter or dir", async () => {
    add("zz-fixture-no-skill", (p) => mkdirSync(p));
    add("zz-fixture-unnamed", (p) => {
      mkdirSync(p);
      writeFileSync(
        path.join(p, "SKILL.md"),
        "---\ndescription: temp fixture without a name\n---\nbody",
      );
    });
    add("zz-fixture-plain", (p) => {
      mkdirSync(p);
      writeFileSync(path.join(p, "SKILL.md"), "no frontmatter here");
    });
    add("zz-fixture-file.txt", (p) => writeFileSync(p, "not a skill dir"));
    add("zz-fixture-dangling", (p) =>
      symlinkSync(path.join(skillsRoot, "missing-target"), p),
    );

    const { harness } = await load(acmeTree());
    const out = (await harness.runCli(["status"])).stdout;
    expect(out).toContain("zz-fixture-unnamed  [global]");
    expect(out).toContain("zz-fixture-plain  [global]");
    expect(out).not.toContain("zz-fixture-no-skill");
    expect(out).not.toContain("zz-fixture-file.txt");
    expect(out).not.toContain("zz-fixture-dangling");
  });
});

describe("project cache", () => {
  it("refreshes through the background loop until the signal aborts", async () => {
    const { harness } = await load(acmeTree());
    const before = harness.sdk.callsTo("projects.list").length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { controller, done } = harness.runService("project-path-cache");
      await vi.advanceTimersByTimeAsync(60_000);
      const afterLoop = harness.sdk.callsTo("projects.list").length;
      expect(afterLoop).toBeGreaterThan(before);
      controller.abort();
      await done;
      expect(harness.sdk.callsTo("projects.list").length).toBe(afterLoop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting as soon as the signal aborts", async () => {
    const { harness } = await load(acmeTree());
    const before = harness.sdk.callsTo("projects.list").length;
    const { controller, done } = harness.runService("project-path-cache");
    controller.abort();
    await done;
    expect(harness.sdk.callsTo("projects.list").length).toBe(before);
  });

  it("refreshes the cache when a thread is created", async () => {
    const app = acmeTree();
    const { harness } = await load(app);
    harness.sdk.stub("projects.list", async () => [
      {
        id: "proj_new",
        gitRemoteUrl: "git@git.example.com:acme/new.git",
        sources: [{ path: app, hostId: SERVER_HOST }],
      },
    ]);
    await harness.install();
    const before = harness.sdk.callsTo("projects.list").length;
    await harness.emitThreadEvent("thread.created", {
      thread: makeThreadResponse({ id: "thr_created" }),
    });
    expect(harness.sdk.callsTo("projects.list").length).toBeGreaterThan(before);
    expect(
      await harness.resolveProviderEnv("claude-code", {
        threadId: "thr_new",
        projectId: "proj_new",
        hostId: SERVER_HOST,
      }),
    ).toEqual([
      expect.objectContaining({
        name: "CLAUDE_CONFIG_DIR",
        value: path.join(home, ".claude-acme"),
      }),
    ]);
  });

  it("pins the default profile for an unknown project and says how to recover", async () => {
    const { harness } = await load(acmeTree());
    expect(
      await harness.resolveProviderEnv("claude-code", {
        threadId: "thr_unknown",
        projectId: "proj_unknown",
        hostId: SERVER_HOST,
      }),
    ).toEqual([]);
    expect(harness.logEntries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("project proj_unknown not resolved"),
      }),
    );
    expect(harness.logEntries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("bb dir-skills unpin thr_unknown"),
      }),
    );
  });

  it("ignores checkouts without a host or with an empty path", async () => {
    const app = acmeTree();
    const { harness } = await load(app);
    harness.sdk.stub("projects.list", async () => [
      { id: "proj_none", gitRemoteUrl: REMOTE },
      {
        id: "proj_hosts",
        gitRemoteUrl: REMOTE,
        sources: [{ path: "" }, { path: app }],
      },
    ]);
    expect(
      await harness.resolveProviderEnv("claude-code", {
        threadId: "thr_hosts",
        projectId: "proj_hosts",
        hostId: SERVER_HOST,
      }),
    ).toEqual([]);
  });

  it("warns with the error message when the project list fails", async () => {
    acmeTree();
    const host = await loadSdk(failingListStub(new Error("boom-secret")));
    expect(host.harness.logEntries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "project list refresh failed: boom-secret",
        ),
      }),
    );
  });

  it("stringifies non-error refresh failures", async () => {
    acmeTree();
    const host = await loadSdk(failingListStub("boom-string"));
    expect(host.harness.logEntries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "project list refresh failed: boom-string",
        ),
      }),
    );
  });

  it("warns when the provider env contribution is unavailable", async () => {
    acmeTree();
    const host = createFakePluginHost({
      pluginId: "dir-skills",
      agentSkillIds: ["work-conventions"],
      sdk: {
        projects: {
          list: async () => [{ id: "proj_app", gitRemoteUrl: REMOTE, sources: [] }],
        },
      },
    });
    const partial = {
      ...host.bb,
      providers: {},
      onInstall: undefined,
    };
    await plugin(partial as unknown as BbPluginApi);
    expect(host.harness.logEntries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "experimental_contributeEnv unavailable",
        ),
      }),
    );
  });

  it("configures skills without an environment path", async () => {
    const app = acmeTree();
    const { harness } = await load(app);
    await harness.install();
    const configured = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        project: { id: "proj_app" },
        environment: { path: undefined },
      }),
    );
    expect(configured.skills).toContain("work-conventions");
  });

  it("resolves the plugin root above a dist directory", async () => {
    const app = acmeTree();
    vi.resetModules();
    vi.doMock("node:url", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:url")>();
      return {
        ...actual,
        fileURLToPath: (url: URL | string) => {
          const p = actual.fileURLToPath(url);
          return p.endsWith(`${path.sep}server.ts`)
            ? path.join(path.dirname(p), "dist", "server.ts")
            : p;
        },
      };
    });
    try {
      const fresh = (await import("./server")).default;
      const host = createFakePluginHost({
        pluginId: "dir-skills",
        agentSkillIds: ["work-conventions"],
        sdk: {
          plugins: { getSettings: async () => ({ values: {} }) },
          projects: {
            list: async () => [
              { id: "proj_app", gitRemoteUrl: REMOTE, sources: [{ path: app, hostId: SERVER_HOST }] },
            ],
          },
          threads: { get: async () => ({ projectId: "proj_app" }) },
        },
      });
      await fresh(host.bb);
      const status = await host.harness.runCli(["status"]);
      expect(status.stdout).toContain(`plugin root: ${pluginDir}`);
      expect(host.harness.logEntries).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: expect.stringContaining("loaded 1 skill(s), 1 scope(s)"),
        }),
      );
    } finally {
      vi.doUnmock("node:url");
      vi.resetModules();
    }
  });
});
