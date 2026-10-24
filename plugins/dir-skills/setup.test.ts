import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseScopes } from "./scopes";
import {
  detectScope,
  normalizeRemote,
  type DetectInputs,
  type SetupProject,
  type SkipReason,
} from "./detect";
import {
  ACP_PLUGIN_IDS,
  autoSetup,
  autoSetupLine,
  runSetup,
  setupCommand,
  SetupError,
  writeScopesFile,
  type SetupDeps,
} from "./setup";

const SENTINEL = "SENTINEL-TOKEN-123";
const WORK_MARKETPLACE = "https://git.example.com/acme/marketplace.git";
const WORK_REMOTE = "https://git.example.com/acme/app.git";
const WORK_KEY = "git.example.com/acme";

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "dir-skills-setup-")));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function settingsFile(dir: string, urls: string[], kind = "git"): void {
  mkdirSync(dir, { recursive: true });
  const extraKnownMarketplaces = Object.fromEntries(
    urls.map((url, i) => [
      `m${i}`,
      { source: kind === "git" ? { source: "git", url } : { source: kind, repo: url } },
    ]),
  );
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ extraKnownMarketplaces }),
  );
}

function repo(parent: string, name: string, remote: string | null): string {
  const dir = path.join(parent, name);
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  if (remote !== null)
    writeFileSync(
      path.join(dir, ".git", "config"),
      `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    );
  return dir;
}

function project(id: string, remote: string | null, ...paths: string[]): SetupProject {
  return { id, gitRemoteUrl: remote, sources: paths.map((p) => ({ path: p })) };
}

function agents(...dirs: string[]): string {
  return JSON.stringify(
    dirs.map((dir, i) => ({
      id: `agent-${i}`,
      env: { CLAUDE_CONFIG_DIR: dir, API_TOKEN: SENTINEL },
    })),
  );
}

function world() {
  const base = mkdtempSync(path.join(tmp, "w-"));
  const home = path.join(base, "home");
  const profile = path.join(home, ".claude-acme");
  const tree = path.join(home, "src", "acme");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(tree, { recursive: true });
  settingsFile(profile, [WORK_MARKETPLACE]);
  const app = repo(tree, "app", WORK_REMOTE);
  const inputs = (over: Partial<DetectInputs> = {}): DetectInputs => ({
    home,
    customAgents: [{ source: "provider-acp", value: agents("~/.claude-acme") }],
    projects: [project("proj_app", WORK_REMOTE, app)],
    ...over,
  });
  return { base, home, profile, tree, app, inputs };
}

function expectSkip(inputs: DetectInputs, reason: SkipReason) {
  const result = detectScope(inputs);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

describe("normalizeRemote", () => {
  it.each([
    ["https://git.example.com/acme/app.git", WORK_KEY],
    ["https://GIT.Example.COM/ACME/App", WORK_KEY],
    ["ssh://git@git.example.com:2222/acme/app.git", WORK_KEY],
    ["ssh://git.example.com/acme/app/", WORK_KEY],
    ["git@git.example.com:acme/app.git", WORK_KEY],
    ["git@GIT.example.com:/acme/app.git", WORK_KEY],
    [`https://user:${SENTINEL}@git.example.com:8443/acme/app.git`, WORK_KEY],
    [`https://${SENTINEL}@git.example.com/acme/app`, WORK_KEY],
    ["https://git.example.com/acme/team/app.git", WORK_KEY],
    ["  https://git.example.com/acme/app.git  ", WORK_KEY],
  ])("%s -> %s", (remote, key) => {
    expect(normalizeRemote(remote)).toBe(key);
  });

  it.each(["", "https://git.example.com", "https://git.example.com/", "not a remote", "/srv/git/app", "file:///srv/git/app"])(
    "has no key for %j",
    (remote) => {
      expect(normalizeRemote(remote)).toBeNull();
    },
  );

  it("keeps an ssh config alias distinct from the real host", () => {
    expect(normalizeRemote("git@work-alias:acme/app.git")).toBe("work-alias/acme");
    expect(normalizeRemote("git@work-alias:acme/app.git")).not.toBe(WORK_KEY);
  });
});

describe("detectScope", () => {
  it("builds the work scope with ~ paths and the matched checkouts", () => {
    const w = world();
    const result = detectScope(w.inputs());
    expect(result).toEqual({
      ok: true,
      candidate: {
        name: "work",
        paths: ["~/src/acme"],
        skills: ["work-*"],
        claudeConfigDir: "~/.claude-acme",
      },
      matches: [{ projectId: "proj_app", path: w.app, key: WORK_KEY }],
      profileSource: "provider-acp",
    });
  });

  it("matches projects that use ssh remotes and several checkouts", () => {
    const w = world();
    const other = repo(w.tree, "other", "git@git.example.com:acme/other.git");
    const result = detectScope(
      w.inputs({
        projects: [
          project("proj_app", "ssh://git@git.example.com:2222/acme/app.git", w.app),
          project("proj_other", "git@GIT.example.com:acme/other.git", other),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.matches.map((m) => m.projectId)).toEqual(["proj_app", "proj_other"]);
  });

  it("uses an absolute path when the work tree is outside the home directory", () => {
    const w = world();
    const outside = path.join(w.base, "srv", "acme");
    const app = repo(outside, "app", WORK_REMOTE);
    const result = detectScope(
      w.inputs({ projects: [project("proj_app", WORK_REMOTE, app)] }),
    );
    expect(result.ok && result.candidate.paths).toEqual([outside]);
  });

  describe("profile", () => {
    it.each([
      ["null", null],
      ["empty", ""],
      ["malformed json", "[{"],
      ["an object", JSON.stringify({ env: { CLAUDE_CONFIG_DIR: "~/.claude-acme" } })],
      ["an agent without env", JSON.stringify([{ id: "a" }])],
      ["an env without the variable", JSON.stringify([{ env: { OTHER: "x" } }])],
      ["a relative dir", agents("claude-acme")],
      ["a missing dir", agents("~/.does-not-exist")],
      ["a non-string dir", JSON.stringify([{ env: { CLAUDE_CONFIG_DIR: 7 } }])],
      ["a non-object entry", JSON.stringify(["oops"])],
    ])("skips no-profile for %s", (_label, value) => {
      const w = world();
      expectSkip(w.inputs({ customAgents: [{ source: "provider-acp", value }] }), "no-profile");
    });

    it("skips no-profile without any source", () => {
      expectSkip(world().inputs({ customAgents: [] }), "no-profile");
    });

    it("rejects the default profile, home, and a parent of home", () => {
      const w = world();
      for (const dir of ["~/.claude", w.home, w.base, "~/"]) {
        expectSkip(
          w.inputs({ customAgents: [{ source: "provider-acp", value: agents(dir) }] }),
          "no-profile",
        );
      }
    });

    it("skips no-profile when the home directory is missing", () => {
      const w = world();
      expectSkip(
        w.inputs({ home: path.join(w.base, "absent-home") }),
        "no-profile",
      );
    });

    it("works without a default profile directory", () => {
      const base = mkdtempSync(path.join(tmp, "nodefault-"));
      const home = path.join(base, "home");
      const profile = path.join(home, ".claude-acme");
      const tree = path.join(home, "src", "acme");
      mkdirSync(tree, { recursive: true });
      settingsFile(profile, [WORK_MARKETPLACE]);
      const app = repo(tree, "app", WORK_REMOTE);
      expect(
        detectScope({
          home,
          customAgents: [{ source: "provider-acp", value: agents("~/.claude-acme") }],
          projects: [project("proj_app", WORK_REMOTE, app)],
        }).ok,
      ).toBe(true);
    });

    it("rejects a symlink that resolves to the default profile", () => {
      const w = world();
      const link = path.join(w.home, ".claude-link");
      symlinkSync(path.join(w.home, ".claude"), link);
      expectSkip(
        w.inputs({ customAgents: [{ source: "provider-acp", value: agents(link) }] }),
        "no-profile",
      );
    });

    it("dedupes one directory spelled as ~/x, absolute, and with a trailing slash", () => {
      const w = world();
      const result = detectScope(
        w.inputs({
          customAgents: [
            {
              source: "provider-acp",
              value: agents("~/.claude-acme", w.profile, `${w.profile}/`),
            },
          ],
        }),
      );
      expect(result.ok).toBe(true);
    });

    it("dedupes the same directory from both plugins and names the first source", () => {
      const w = world();
      const result = detectScope(
        w.inputs({
          customAgents: [
            { source: "provider-acp", value: agents("~/.claude-acme") },
            { source: "bb--provider-acp-next", value: agents(w.profile) },
          ],
        }),
      );
      expect(result.ok && result.profileSource).toBe("provider-acp");
    });

    it("takes the profile from the second plugin when the first has none", () => {
      const w = world();
      const result = detectScope(
        w.inputs({
          customAgents: [
            { source: "provider-acp", value: null },
            { source: "bb--provider-acp-next", value: agents("~/.claude-acme") },
          ],
        }),
      );
      expect(result.ok && result.profileSource).toBe("bb--provider-acp-next");
    });

    it("skips ambiguous-profiles for two distinct directories", () => {
      const w = world();
      mkdirSync(path.join(w.home, ".claude-other"));
      expectSkip(
        w.inputs({
          customAgents: [
            { source: "provider-acp", value: agents("~/.claude-acme", "~/.claude-other") },
          ],
        }),
        "ambiguous-profiles",
      );
    });
  });

  describe("marketplaces", () => {
    it("skips when the profile has no settings.json", () => {
      const w = world();
      rmSync(path.join(w.profile, "settings.json"));
      expectSkip(w.inputs(), "no-self-hosted-marketplace");
    });

    it("skips when the profile settings.json is malformed", () => {
      const w = world();
      writeFileSync(path.join(w.profile, "settings.json"), `{ "token": "${SENTINEL}`);
      expectSkip(w.inputs(), "no-self-hosted-marketplace");
    });

    it("skips when the profile settings.json is not an object", () => {
      const w = world();
      writeFileSync(path.join(w.profile, "settings.json"), "[]");
      expectSkip(w.inputs(), "no-self-hosted-marketplace");
    });

    it("ignores marketplace entries that are not objects", () => {
      const w = world();
      writeFileSync(
        path.join(w.profile, "settings.json"),
        JSON.stringify({ extraKnownMarketplaces: { a: "nope", b: 7 } }),
      );
      expectSkip(w.inputs(), "no-self-hosted-marketplace");
    });

    it("ignores git marketplaces whose url does not parse", () => {
      const w = world();
      settingsFile(w.profile, ["not a remote", "https://git.example.com"]);
      expectSkip(w.inputs(), "no-self-hosted-marketplace");
    });

    it("ignores marketplaces that are not git sources", () => {
      const w = world();
      settingsFile(w.profile, ["acme/marketplace"], "github");
      expectSkip(w.inputs(), "no-self-hosted-marketplace");
    });

    it.each([
      "https://github.com/vendor/marketplace.git",
      "git@github.com:vendor/marketplace.git",
      "https://gitlab.com/vendor/marketplace",
      "https://bitbucket.org/vendor/marketplace",
      "https://codeberg.org/vendor/marketplace",
    ])("excludes the public forge %s", (url) => {
      const w = world();
      settingsFile(w.profile, [url]);
      expectSkip(w.inputs(), "no-self-hosted-marketplace");
    });

    it("does not treat a project under a public forge group as work", () => {
      const w = world();
      settingsFile(w.profile, [WORK_MARKETPLACE, "https://github.com/vendor/marketplace.git"]);
      const vendor = repo(w.tree, "vendor-app", "https://github.com/vendor/app.git");
      expectSkip(
        w.inputs({ projects: [project("proj_vendor", "https://github.com/vendor/app.git", vendor)] }),
        "no-project-match",
      );
    });

    it("drops keys the default profile also has", () => {
      const w = world();
      settingsFile(path.join(w.home, ".claude"), [WORK_MARKETPLACE]);
      expectSkip(w.inputs(), "no-self-hosted-marketplace");
    });

    it("keeps keys the default profile lacks", () => {
      const w = world();
      settingsFile(path.join(w.home, ".claude"), ["https://git.example.com/shared/m.git"]);
      settingsFile(w.profile, [WORK_MARKETPLACE, "https://git.example.com/shared/m.git"]);
      expect(detectScope(w.inputs()).ok).toBe(true);
    });

    it("does not match an ssh config alias host", () => {
      const w = world();
      settingsFile(w.profile, ["git@work-alias:acme/marketplace.git"]);
      expectSkip(w.inputs(), "no-project-match");
    });
  });

  describe("projects", () => {
    it("skips no-project-match when no remote matches", () => {
      const w = world();
      expectSkip(
        w.inputs({ projects: [project("p", "https://git.example.com/other/app.git", w.app)] }),
        "no-project-match",
      );
    });

    it("skips projects without a remote or without a local checkout", () => {
      const w = world();
      expectSkip(
        w.inputs({
          projects: [
            project("p1", null, w.app),
            project("p2", WORK_REMOTE, path.join(w.tree, "missing")),
            { id: "p3", gitRemoteUrl: WORK_REMOTE },
          ],
        }),
        "no-project-match",
      );
    });

    it("ignores pathless sources and keeps real ones", () => {
      const w = world();
      const result = detectScope(
        w.inputs({
          projects: [
            {
              id: "proj_app",
              gitRemoteUrl: WORK_REMOTE,
              sources: [{ path: null }, { path: w.app }],
            },
          ],
        }),
      );
      expect(result.ok && result.matches).toEqual([
        { projectId: "proj_app", path: w.app, key: WORK_KEY },
      ]);
    });

    it("sorts matches by path regardless of project order", () => {
      const w = world();
      const aaa = repo(w.tree, "aaa", WORK_REMOTE);
      const zzz = repo(w.tree, "zzz", WORK_REMOTE);
      const result = detectScope(
        w.inputs({
          projects: [
            project("proj_z", WORK_REMOTE, zzz),
            project("proj_a", WORK_REMOTE, aaa),
            project("proj_dup", WORK_REMOTE, zzz),
          ],
        }),
      );
      expect(result.ok && result.matches.map((m) => m.path)).toEqual([
        aaa,
        zzz,
        zzz,
      ]);
    });
  });

  describe("parent directory", () => {
    it("skips no-common-parent when checkouts live in different parents", () => {
      const w = world();
      const elsewhere = repo(path.join(w.home, "src", "acme-two"), "app2", WORK_REMOTE);
      expectSkip(
        w.inputs({
          projects: [
            project("p1", WORK_REMOTE, w.app),
            project("p2", WORK_REMOTE, elsewhere),
          ],
        }),
        "no-common-parent",
      );
    });

    it("skips a nested layout", () => {
      const w = world();
      const nested = repo(path.join(w.tree, "group"), "app2", WORK_REMOTE);
      expectSkip(
        w.inputs({
          projects: [
            project("p1", WORK_REMOTE, w.app),
            project("p2", WORK_REMOTE, nested),
          ],
        }),
        "no-common-parent",
      );
    });

    it("skips no-common-parent when the parent is the home directory", () => {
      const w = world();
      const direct = repo(w.home, "direct", WORK_REMOTE);
      expectSkip(
        w.inputs({ projects: [project("p", WORK_REMOTE, direct)] }),
        "no-common-parent",
      );
    });

    it("skips no-common-parent when the parent is above the home directory", () => {
      const w = world();
      const above = repo(w.base, "above", WORK_REMOTE);
      expectSkip(
        w.inputs({ projects: [project("p", WORK_REMOTE, above)] }),
        "no-common-parent",
      );
    });

    it("skips parent-has-non-work-entries for an unregistered personal repo", () => {
      const w = world();
      repo(w.tree, "dotfiles", "https://github.com/me/dotfiles.git");
      expectSkip(w.inputs(), "parent-has-non-work-entries");
    });

    it("skips parent-has-non-work-entries for a non-git folder", () => {
      const w = world();
      mkdirSync(path.join(w.tree, "scratch"));
      expectSkip(w.inputs(), "parent-has-non-work-entries");
    });

    it("skips parent-has-non-work-entries for a plain file", () => {
      const w = world();
      writeFileSync(path.join(w.tree, "notes.txt"), "x");
      expectSkip(w.inputs(), "parent-has-non-work-entries");
    });

    it("skips parent-has-non-work-entries for another bb project with a non-work remote", () => {
      const w = world();
      const personal = repo(w.tree, "personal", "https://github.com/me/personal.git");
      expectSkip(
        w.inputs({
          projects: [
            project("p1", WORK_REMOTE, w.app),
            project("p2", "https://github.com/me/personal.git", personal),
          ],
        }),
        "parent-has-non-work-entries",
      );
    });

    it("skips parent-has-non-work-entries for a repo with no origin", () => {
      const w = world();
      repo(w.tree, "local-only", null);
      expectSkip(w.inputs(), "parent-has-non-work-entries");
    });

    it("treats a .git gitfile as non-work", () => {
      const w = world();
      const worktree = path.join(w.tree, "linked");
      mkdirSync(worktree);
      writeFileSync(path.join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n");
      expectSkip(w.inputs(), "parent-has-non-work-entries");
    });

    it("ignores dot entries in the parent", () => {
      const w = world();
      writeFileSync(path.join(w.tree, ".DS_Store"), "x");
      mkdirSync(path.join(w.tree, ".cache"));
      expect(detectScope(w.inputs()).ok).toBe(true);
    });

    it("accepts work repos that are not registered as bb projects", () => {
      const w = world();
      repo(w.tree, "sibling", "git@git.example.com:acme/sibling.git");
      expect(detectScope(w.inputs()).ok).toBe(true);
    });

    it("reads the origin url only from the origin remote section", () => {
      const w = world();
      const sibling = path.join(w.tree, "sibling");
      mkdirSync(path.join(sibling, ".git"), { recursive: true });
      writeFileSync(
        path.join(sibling, ".git", "config"),
        `[remote "upstream"]\n\turl = ${WORK_REMOTE}\n[remote "origin"]\n\turl = https://github.com/me/sibling.git\n`,
      );
      expectSkip(w.inputs(), "parent-has-non-work-entries");
    });

    it("skips parent-has-non-work-entries for an origin section without a url", () => {
      const w = world();
      const sibling = path.join(w.tree, "sibling");
      mkdirSync(path.join(sibling, ".git"), { recursive: true });
      writeFileSync(
        path.join(sibling, ".git", "config"),
        `[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
      );
      expectSkip(w.inputs(), "parent-has-non-work-entries");
    });

    it("skips parent-has-non-work-entries when the parent is unreadable", () => {
      const w = world();
      // Search (x) without read (r): checkouts stay resolvable, the listing fails.
      chmodSync(w.tree, 0o111);
      try {
        expectSkip(w.inputs(), "parent-has-non-work-entries");
      } finally {
        chmodSync(w.tree, 0o755);
      }
    });
  });

  it("works through a symlinked home directory", () => {
    const base = mkdtempSync(path.join(tmp, "link-"));
    const real = path.join(base, "private", "home");
    const link = path.join(base, "home-link");
    mkdirSync(path.join(real, ".claude"), { recursive: true });
    symlinkSync(real, link);
    settingsFile(path.join(link, ".claude-acme"), [WORK_MARKETPLACE]);
    const app = repo(path.join(link, "src", "acme"), "app", WORK_REMOTE);
    const result = detectScope({
      home: link,
      customAgents: [{ source: "provider-acp", value: agents("~/.claude-acme") }],
      projects: [project("proj_app", WORK_REMOTE, app)],
    });
    expect(result.ok && result.candidate).toEqual({
      name: "work",
      paths: ["~/src/acme"],
      skills: ["work-*"],
      claudeConfigDir: "~/.claude-acme",
    });
    expect(result.matches[0].path).toBe(path.join(real, "src", "acme", "app"));
    if (result.ok) {
      const target = path.join(base, "scopes.json");
      expect(writeScopesFile(target, result.candidate, link)).toBe("wrote");
      expect(parseScopes(target, link)[0].paths).toEqual([path.join(real, "src", "acme")]);
    }
  });
});

type Behaviour = "ok" | "throw";

interface Harness {
  deps: SetupDeps;
  logs: string[];
  kv: Map<string, unknown>;
  reloads: { count: number };
  userFile: string;
  w: ReturnType<typeof world>;
}

function harness(
  opts: {
    w?: ReturnType<typeof world>;
    plugin?: Behaviour;
    next?: Behaviour;
    nextAgents?: string;
    projects?: SetupProject[];
    projectsFail?: boolean;
    kv?: Record<string, unknown>;
    threads?: Record<string, string>;
    pluginAgents?: string;
  } = {},
): Harness {
  const w = opts.w ?? world();
  const logs: string[] = [];
  const kv = new Map<string, unknown>(Object.entries(opts.kv ?? {}));
  const reloads = { count: 0 };
  const userFile = path.join(w.home, ".bb", "dir-skills", "scopes.json");
  const projects = opts.projects ?? [project("proj_app", WORK_REMOTE, w.app)];
  const record = (level: string) => (message: string) => void logs.push(`${level}: ${message}`);
  const deps: SetupDeps = {
    home: w.home,
    userFile,
    sdk: {
      plugins: {
        async getSettings({ pluginId }) {
          const behaviour = pluginId === ACP_PLUGIN_IDS[0] ? opts.plugin : opts.next;
          if (behaviour === "throw") throw new Error(`404 ${SENTINEL}`);
          if (pluginId === ACP_PLUGIN_IDS[0])
            return { values: { customAgents: opts.pluginAgents ?? agents("~/.claude-acme") } };
          return { values: opts.nextAgents ? { customAgents: opts.nextAgents } : {} };
        },
      },
      projects: {
        async list() {
          if (opts.projectsFail) throw new Error(`boom ${SENTINEL}`);
          return projects;
        },
      },
      threads: {
        async get({ threadId }) {
          const projectId = opts.threads?.[threadId];
          if (!projectId) throw new Error(`no thread ${SENTINEL}`);
          return { projectId };
        },
      },
    },
    kv: {
      async get(key: string) {
        return kv.get(key);
      },
      async set(key: string, value: unknown) {
        kv.set(key, value);
      },
      async list(prefix?: string) {
        return [...kv.keys()].filter((key) => key.startsWith(prefix ?? ""));
      },
    } as unknown as SetupDeps["kv"],
    log: { debug: record("debug"), info: record("info"), warn: record("warn") },
    reload() {
      reloads.count += 1;
    },
  };
  return { deps, logs, kv, reloads, userFile, w };
}

describe("runSetup", () => {
  it("writes the user file with private permissions and records the outcome", async () => {
    const h = harness();
    const report = await runSetup(h.deps, { dryRun: false });
    expect(report.outcome).toBe("wrote");
    expect(report.profileSource).toBe("provider-acp");
    expect(JSON.parse(readFileSync(h.userFile, "utf8"))).toEqual({
      scopes: [
        {
          name: "work",
          paths: ["~/src/acme"],
          skills: ["work-*"],
          claudeConfigDir: "~/.claude-acme",
        },
      ],
    });
    expect(statSync(h.userFile).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(h.userFile)).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.dirname(h.userFile))).toEqual(["scopes.json"]);
    expect(h.reloads.count).toBe(1);
    expect(h.kv.get("auto-setup")).toEqual({ outcome: "wrote" });
    expect(autoSetupLine(h.kv.get("auto-setup") as never)).toBe("auto-setup: wrote");
  });

  it("never refreshes an existing file", async () => {
    const h = harness();
    mkdirSync(path.dirname(h.userFile), { recursive: true });
    writeFileSync(h.userFile, '{"scopes":[]}');
    const report = await runSetup(h.deps, { dryRun: false });
    expect(report).toMatchObject({ outcome: "skipped", reason: "exists" });
    expect(readFileSync(h.userFile, "utf8")).toBe('{"scopes":[]}');
    expect(h.reloads.count).toBe(0);
    expect(autoSetupLine(h.kv.get("auto-setup") as never)).toBe("auto-setup: skipped (exists)");
  });

  it("keeps an earlier wrote record when a later run finds the file", async () => {
    const h = harness();
    await runSetup(h.deps, { dryRun: false });
    await runSetup(h.deps, { dryRun: false });
    expect(h.kv.get("auto-setup")).toEqual({ outcome: "wrote" });
  });

  it("dry-run prints the candidate and would-skip exists without touching anything", async () => {
    const h = harness();
    mkdirSync(path.dirname(h.userFile), { recursive: true });
    writeFileSync(h.userFile, '{"scopes":[]}');
    const result = await setupCommand(h.deps, ["--dry-run"], false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("would skip: exists");
    expect(result.stdout).toContain("claudeConfigDir: ~/.claude-acme");
    expect(result.stdout).toContain(`(${WORK_KEY})`);
    expect(readFileSync(h.userFile, "utf8")).toBe('{"scopes":[]}');
    expect(h.kv.has("auto-setup")).toBe(false);
    expect(h.reloads.count).toBe(0);
  });

  it("dry-run on a missing file writes nothing and records nothing", async () => {
    const h = harness();
    const result = await setupCommand(h.deps, ["--dry-run"], true);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout!);
    expect(payload).toMatchObject({
      outcome: "dry-run",
      candidate: { name: "work", paths: ["~/src/acme"] },
      matches: [{ projectId: "proj_app", key: WORK_KEY }],
      profileSource: "provider-acp",
      affectedThreads: [],
    });
    expect(payload.reason).toBeUndefined();
    expect(existsSync(h.userFile)).toBe(false);
    expect(h.kv.size).toBe(0);
  });

  it("--json reports a write with the matches", async () => {
    const h = harness();
    const result = await setupCommand(h.deps, [], true);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!)).toMatchObject({
      outcome: "wrote",
      matches: [{ projectId: "proj_app", path: h.w.app, key: WORK_KEY }],
      affectedThreads: [],
    });
  });

  it("rejects unknown flags", async () => {
    const result = await setupCommand(harness().deps, ["--force"], false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage:");
  });

  describe.each<[SkipReason, (h: Harness) => void]>([
    ["no-profile", () => {}],
    ["ambiguous-profiles", (h) => mkdirSync(path.join(h.w.home, ".claude-other"))],
    ["no-self-hosted-marketplace", (h) => settingsFile(h.w.profile, [])],
    ["no-project-match", () => {}],
    ["no-common-parent", (h) => repo(h.w.home, "x", WORK_REMOTE)],
    ["parent-has-non-work-entries", (h) => mkdirSync(path.join(h.w.tree, "scratch"))],
  ])("skip %s", (reason, tweak) => {
    it("exits 2, names the reason, and records it", async () => {
      const w = world();
      const h = harness({
        w,
        pluginAgents:
          reason === "no-profile"
            ? agents("~/.nope")
            : reason === "ambiguous-profiles"
              ? agents("~/.claude-acme", "~/.claude-other")
              : undefined,
        projects:
          reason === "no-project-match"
            ? [project("p", "https://git.example.com/other/x.git", w.app)]
            : reason === "no-common-parent"
              ? [project("p", WORK_REMOTE, path.join(w.home, "x"))]
              : undefined,
      });
      tweak(h);
      for (const json of [false, true]) {
        const result = await setupCommand(h.deps, [], json);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toContain(reason);
      }
      expect(existsSync(h.userFile)).toBe(false);
      expect(h.kv.get("auto-setup")).toEqual({ outcome: "skipped", reason });
      expect(autoSetupLine(h.kv.get("auto-setup") as never)).toBe(
        `auto-setup: skipped (${reason})`,
      );
    });
  });

  it("exits 2 with exists when the file is present", async () => {
    const h = harness();
    mkdirSync(path.dirname(h.userFile), { recursive: true });
    writeFileSync(h.userFile, '{"scopes":[]}');
    expect((await setupCommand(h.deps, [], false)).exitCode).toBe(2);
  });

  describe("provider plugin settings", () => {
    it("survives a failure of the first plugin", async () => {
      const h = harness({ plugin: "throw", nextAgents: agents("~/.claude-acme") });
      const report = await runSetup(h.deps, { dryRun: true });
      expect(report.outcome).toBe("dry-run");
      expect(report.profileSource).toBe("bb--provider-acp-next");
    });

    it("survives a failure of the second plugin", async () => {
      const h = harness({ next: "throw" });
      expect((await runSetup(h.deps, { dryRun: true })).profileSource).toBe("provider-acp");
    });

    it("skips no-profile when both plugins fail", async () => {
      const h = harness({ plugin: "throw", next: "throw" });
      expect(await runSetup(h.deps, { dryRun: true })).toMatchObject({
        outcome: "skipped",
        reason: "no-profile",
      });
    });

    it("skips ambiguous-profiles when the plugins disagree", async () => {
      const w = world();
      mkdirSync(path.join(w.home, ".claude-other"));
      const h = harness({ w, nextAgents: agents("~/.claude-other") });
      expect(await runSetup(h.deps, { dryRun: true })).toMatchObject({
        reason: "ambiguous-profiles",
      });
    });
  });

  describe("failures", () => {
    it("reports a project list failure with a fixed message", async () => {
      const h = harness({ projectsFail: true });
      const result = await setupCommand(h.deps, [], false);
      expect(result).toEqual({ exitCode: 1, stderr: "setup: could not list projects\n" });
      expect(h.kv.size).toBe(0);
    });

    it("autoSetup logs a fixed warning instead of throwing", async () => {
      const h = harness({ projectsFail: true });
      await autoSetup(h.deps);
      expect(h.logs).toContain("warn: auto-setup: could not list projects");
      expect(h.logs.join("\n")).not.toContain(SENTINEL);
    });

    it("autoSetup writes when the plugin is installed", async () => {
      const h = harness();
      await autoSetup(h.deps);
      expect(existsSync(h.userFile)).toBe(true);
      expect(h.logs).toContain("info: auto-setup: wrote scopes.json");
    });

    it("explains a failed reload with a fixed message", async () => {
      const h = harness();
      h.deps.reload = () => {
        throw new Error(`reload ${SENTINEL}`);
      };
      const result = await setupCommand(h.deps, [], false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("could not be reloaded");
      expect(result.stderr).not.toContain(SENTINEL);
    });
  });

  describe("affected threads", () => {
    const pins = {
      "claude-config-dir:thr_covered": { dir: null, scope: null },
      "claude-config-dir:thr_zeta": { dir: null, scope: null, reason: "unknown-project" },
      "claude-config-dir:thr_pinned": { dir: "/x/profile", scope: "other" },
      "claude-config-dir:thr_elsewhere": { dir: null, scope: null },
      "claude-config-dir:thr_gone": { dir: null, scope: null },
      "unrelated:thr_covered": { dir: null },
    };
    const threads = {
      thr_covered: "proj_app",
      thr_zeta: "proj_app",
      thr_pinned: "proj_app",
      thr_elsewhere: "proj_other",
    };

    it("lists default-profile pins whose project the new scope covers", async () => {
      const w = world();
      const other = repo(path.join(w.home, "elsewhere"), "o", "https://github.com/me/o.git");
      const h = harness({
        w,
        projects: [project("proj_app", WORK_REMOTE, w.app), project("proj_other", "https://github.com/me/o.git", other)],
        kv: pins,
        threads,
      });
      const report = await runSetup(h.deps, { dryRun: false });
      expect(report.affectedThreads).toEqual(["thr_covered", "thr_zeta"]);
    });

    it("prints the unpin hint for each", async () => {
      const h = harness({ kv: pins, threads });
      const result = await setupCommand(h.deps, [], false);
      expect(result.stdout).toContain("bb dir-skills unpin thr_covered");
      expect(result.stdout).toContain("bb dir-skills unpin thr_zeta");
      expect(result.stdout).not.toContain("thr_pinned");
    });

    it("does not look up threads on a dry run", async () => {
      const h = harness({ kv: pins, threads });
      expect((await runSetup(h.deps, { dryRun: true })).affectedThreads).toEqual([]);
    });

    it("skips projects with no sources or pathless entries", async () => {
      const w = world();
      const h = harness({
        w,
        projects: [
          { id: "proj_none", gitRemoteUrl: null },
          { id: "proj_pathless", gitRemoteUrl: null, sources: [{ path: null }] },
          project("proj_app", WORK_REMOTE, w.app),
        ],
        kv: { "claude-config-dir:thr_covered": { dir: null, scope: null } },
        threads: { thr_covered: "proj_pathless" },
      });
      const report = await runSetup(h.deps, { dryRun: false });
      expect(report.affectedThreads).toEqual([]);
    });
  });

  it("reports exists when the file appears as a dangling symlink", async () => {
    const h = harness();
    mkdirSync(path.dirname(h.userFile), { recursive: true });
    symlinkSync(path.join(h.w.base, "nowhere"), h.userFile);
    const report = await runSetup(h.deps, { dryRun: false });
    expect(report).toMatchObject({ outcome: "skipped", reason: "exists" });
    expect(existsSync(path.join(h.w.base, "nowhere"))).toBe(false);
  });

  it("reports a fixed failure when recording the outcome throws", async () => {
    const h = harness();
    h.deps.kv.set = async () => {
      throw new Error(`disk ${SENTINEL}`);
    };
    const result = await setupCommand(h.deps, [], false);
    expect(result).toEqual({ exitCode: 1, stderr: "setup: failed\n" });
  });

  it("logs a fixed warning when auto-setup fails unexpectedly", async () => {
    const h = harness();
    h.deps.kv.set = async () => {
      throw new Error(`disk ${SENTINEL}`);
    };
    await autoSetup(h.deps);
    expect(h.logs).toContain("warn: auto-setup: failed");
    expect(h.logs.join("\n")).not.toContain(SENTINEL);
  });

  it("gives no auto-setup line without a record", () => {
    expect(autoSetupLine(undefined)).toBeNull();
  });
});

describe("writeScopesFile", () => {
  const candidate = {
    name: "work",
    paths: ["~/src/acme"],
    skills: ["work-*"],
    claudeConfigDir: "~/.claude-acme",
  };

  it("leaves a file created before the link untouched and reports exists", () => {
    const w = world();
    const target = path.join(w.home, ".bb", "dir-skills", "scopes.json");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "user content");
    expect(writeScopesFile(target, candidate, w.home)).toBe("exists");
    expect(readFileSync(target, "utf8")).toBe("user content");
    expect(readdirSync(path.dirname(target))).toEqual(["scopes.json"]);
  });

  it("does not follow a dangling symlink at the target", () => {
    const w = world();
    const target = path.join(w.home, ".bb", "dir-skills", "scopes.json");
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(path.join(w.base, "nowhere"), target);
    expect(writeScopesFile(target, candidate, w.home)).toBe("exists");
    expect(existsSync(path.join(w.base, "nowhere"))).toBe(false);
  });

  it("removes the temp file and fails with a fixed message when validation rejects it", () => {
    const w = world();
    const dir = path.join(w.home, ".bb", "dir-skills");
    const target = path.join(dir, "scopes.json");
    let thrown: unknown;
    try {
      writeScopesFile(target, { ...candidate, claudeConfigDir: w.home }, w.home);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SetupError);
    expect((thrown as Error).message).toBe("could not write scopes.json");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves a directory at the target alone and reports exists", () => {
    const w = world();
    const dir = path.join(w.home, ".bb", "dir-skills");
    const target = path.join(dir, "scopes.json");
    mkdirSync(target, { recursive: true });
    expect(writeScopesFile(target, candidate, w.home)).toBe("exists");
    expect(statSync(target).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual(["scopes.json"]);
  });

  it("fails with a fixed message when the target is unusable", () => {
    const w = world();
    const dir = path.join(w.home, ".bb", "dir-skills");
    mkdirSync(dir, { recursive: true });
    let thrown: unknown;
    try {
      writeScopesFile(path.join(dir, "bad\u0000name"), candidate, w.home);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SetupError);
    expect((thrown as Error).message).toBe("could not write scopes.json");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("secrets", () => {
  function collect(h: Harness, outputs: Array<{ stdout?: string; stderr?: string }>): string {
    return [
      ...h.logs,
      ...outputs.flatMap((o) => [o.stdout ?? "", o.stderr ?? ""]),
    ].join("\n");
  }

  async function runAll(h: Harness) {
    return [
      await setupCommand(h.deps, ["--dry-run"], false),
      await setupCommand(h.deps, ["--dry-run"], true),
      await setupCommand(h.deps, [], false),
      await setupCommand(h.deps, [], true),
    ];
  }

  it("never prints a token from another agent's env, a remote's userinfo, or a thrown settings error", async () => {
    const w = world();
    const userinfo = `https://oauth2:${SENTINEL}@git.example.com:8443/acme/app.git`;
    const h = harness({
      w,
      plugin: "throw",
      nextAgents: agents("~/.claude-acme"),
      projects: [project("proj_app", userinfo, w.app)],
    });
    const outputs = await runAll(h);
    expect(outputs.map((o) => o.exitCode)).toEqual([0, 0, 0, 2]);
    const all = collect(h, outputs);
    expect(all).toContain(WORK_KEY);
    expect(all).not.toContain(SENTINEL);
    expect(readFileSync(h.userFile, "utf8")).not.toContain(SENTINEL);
  });

  it("never prints text from a malformed customAgents value", async () => {
    const h = harness({ pluginAgents: `[{"env":{"API_TOKEN":"${SENTINEL}"` });
    const outputs = await runAll(h);
    expect(outputs.map((o) => o.exitCode)).toEqual([2, 2, 2, 2]);
    expect(collect(h, outputs)).not.toContain(SENTINEL);
  });

  it("never prints text from a malformed profile settings.json", async () => {
    const w = world();
    writeFileSync(path.join(w.profile, "settings.json"), `{"apiKey": "${SENTINEL}", oops`);
    const h = harness({ w });
    const outputs = await runAll(h);
    expect(outputs.map((o) => o.exitCode)).toEqual([2, 2, 2, 2]);
    expect(collect(h, outputs)).not.toContain(SENTINEL);
  });

  it("never prints a token when the project list fails", async () => {
    const h = harness({ projectsFail: true });
    const outputs = await runAll(h);
    await autoSetup(h.deps);
    expect(collect(h, outputs)).not.toContain(SENTINEL);
  });
});
