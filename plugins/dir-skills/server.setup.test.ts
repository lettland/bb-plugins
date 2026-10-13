import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
