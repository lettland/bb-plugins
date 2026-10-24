import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

async function load(app: string) {
  const host = createFakePluginHost({
    pluginId: "dir-skills",
    agentSkillIds: ["work-conventions"],
    sdk: {
      plugins: {
        getSettings: async ({ pluginId }: { pluginId: string }) => {
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
