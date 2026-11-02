import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  experimental_runVcsProcess,
  type ExperimentalVcsProcessPriority,
} from "@get-bb/plugin-sdk/host";
import plugin from "./server";
import { installFakeGh } from "./testing/fake-gh";

vi.mock("@get-bb/plugin-sdk/host", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@get-bb/plugin-sdk/host")>();
  return {
    ...actual,
    experimental_runVcsProcess: vi.fn(actual.experimental_runVcsProcess),
  };
});

let binDir: string;
let callLog: string;
let restoreEnv: () => void;

function ghCalls(): string[] {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "bb-github-rpc-"));
  callLog = join(binDir, "gh-calls.log");
  const openIssue = [
    {
      number: 7,
      title: "Cache mutations",
      state: "OPEN",
      author: { login: "alice", id: "user-alice" },
      labels: { nodes: [{ name: "bug" }, { name: "old" }] },
      assignees: { nodes: [{ login: "octocat" }] },
      url: "https://github.com/acme/widgets/issues/7",
      body: "Keep the cache synchronized.",
      updatedAt: "2026-08-19T12:00:00Z",
    },
  ];
  const openPull = [
    {
      number: 42,
      title: "Normalize pull details",
      state: "OPEN",
      author: { login: "bob", id: "user-bob" },
      labels: { nodes: [{ name: "enhancement" }] },
      assignees: { nodes: [] },
      url: "https://github.com/acme/widgets/pull/42",
      body: "Normalize every GitHub shape.",
      updatedAt: "2026-08-19T13:00:00Z",
    },
  ];
  const lists = JSON.stringify({
    data: {
      repository: {
        hasIssuesEnabled: true,
        openIssues: { nodes: openIssue },
        closedIssues: { nodes: [] },
        openPrs: { nodes: openPull },
        closedPrs: { nodes: [] },
      },
    },
  });
  const issueDetail = JSON.stringify({
    number: 7,
    title: "Cache mutations",
    state: "OPEN",
    author: { login: "alice" },
    labels: [{ name: "bug" }],
    assignees: [{ login: "octocat" }],
    url: "https://github.com/acme/widgets/issues/7",
    body: "Live issue body.",
    updatedAt: "2026-08-19T12:00:00Z",
    comments: [],
  });
  const pullDetail = JSON.stringify({
    number: 42,
    title: "Normalize pull details",
    state: "OPEN",
    isDraft: true,
    author: { login: "bob" },
    body: "Pull body.",
    url: "https://github.com/acme/widgets/pull/42",
    createdAt: "2026-08-18T12:00:00Z",
    updatedAt: "2026-08-19T13:00:00Z",
    baseRefName: "main",
    headRefName: "feature",
    additions: 12,
    deletions: 3,
    labels: [{ name: "enhancement" }],
    assignees: [{ login: "octocat" }],
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    reviewRequests: [{ login: "reviewer" }, { name: "core-team" }],
    statusCheckRollup: [
      {
        name: "build",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://ci.example/build",
      },
      {
        context: "legacy",
        state: "FAILURE",
        targetUrl: "https://ci.example/legacy",
      },
      { name: "queued", status: "QUEUED" },
      { name: "skipped", status: "COMPLETED", conclusion: "SKIPPED" },
    ],
    comments: [
      {
        author: { login: "commenter" },
        body: "Conversation comment",
        createdAt: "2026-08-19T14:00:00Z",
      },
    ],
    reviews: [
      {
        author: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        body: "Please fix this.",
        submittedAt: "2026-08-19T15:00:00Z",
      },
    ],
  });
  const reviewComments = JSON.stringify([
    [
      {
        id: 100,
        path: "src/index.ts",
        line: 9,
        diff_hunk: "@@ -1 +1 @@",
        body: "Root comment",
        created_at: "2026-08-19T16:00:00Z",
        user: { login: "reviewer" },
      },
      {
        id: 101,
        in_reply_to_id: 100,
        body: "Reply",
        created_at: "2026-08-19T16:05:00Z",
        user: { login: "bob" },
      },
    ],
    [
      {
        id: 102,
        path: "src/other.ts",
        original_line: 4,
        body: "Second thread",
        created_at: "2026-08-19T17:00:00Z",
        user: { login: "reviewer" },
      },
    ],
  ]);
  const pullFiles = JSON.stringify([
    [
      {
        filename: "src/index.ts",
        status: "modified",
        additions: 10,
        deletions: 2,
        patch: "@@ -1 +1 @@",
      },
    ],
    [
      {
        filename: "src/other.ts",
        status: "added",
        additions: 2,
        deletions: 1,
      },
    ],
  ]);

  restoreEnv = installFakeGh(
    binDir,
    `const callLog = ${JSON.stringify(callLog)};
const joined = args.join(" ");
fs.appendFileSync(callLog, joined + "\\n");
const exact = {
  "--version": "gh version 2.96.0 (fake)",
  "auth status --hostname github.com --active": "authenticated",
  "api user": '{"login":"octocat"}',
  "api repos/acme/widgets/assignees?per_page=100": '[{"login":"zoe"},{"login":"alice"},{"login":""}]',
  "api repos/acme/widgets/labels?per_page=100": '[{"name":"triage"},{"name":" bug "},{"name":""}]',
  "issue view 7 -R acme/widgets --json labels": '{"labels":[{"name":"bug"},{"name":"old"}]}',
  "api --paginate --slurp repos/acme/widgets/pulls/42/comments?per_page=100": ${JSON.stringify(reviewComments)},
  "api --paginate --slurp repos/acme/widgets/pulls/42/files?per_page=100": ${JSON.stringify(pullFiles)},
};
const prefixed = [
  ["api graphql ", ${JSON.stringify(lists)}],
  ["issue view 7 -R acme/widgets --json", ${JSON.stringify(issueDetail)}],
  ["pr view 42 -R acme/widgets --json", ${JSON.stringify(pullDetail)}],
  ["issue edit ", "[]"],
];
const prefixMatch = prefixed.find(([prefix]) => joined.startsWith(prefix));
out((exact[joined] ?? prefixMatch?.[1] ?? "[]") + "\\n");`,
  );
});

afterEach(() => {
  restoreEnv();
  rmSync(binDir, { recursive: true, force: true });
});

async function loadPlugin(extraRepos = "acme/widgets") {
  const host = createFakePluginHost({
    pluginId: "github",
    settings: { extraRepos },
  });
  await plugin(host.bb);
  return host;
}

describe("github plugin RPC behavior", () => {
  it("reports extraRepos entries it cannot honor instead of dropping them", async () => {
    const { harness } = await loadPlugin("acme/widgets, ACME-ORG/*, nonsense");

    await expect(harness.runCli(["repos"])).resolves.toEqual({
      exitCode: 0,
      stdout: "acme/widgets",
      stderr:
        'ignoring 2 extraRepos entries that are not "owner/repo": ACME-ORG/*, nonsense\n',
    });
    expect(harness.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message:
            'ignoring 2 extraRepos entries that are not "owner/repo": ACME-ORG/*, nonsense',
        }),
      ]),
    );

    await harness.runCli(["repos"]);
    expect(
      harness.logEntries.filter(
        (entry) =>
          entry.level === "warn" && entry.message.includes("extraRepos"),
      ),
    ).toHaveLength(1);
  });

  it("says nothing about extraRepos when every entry is usable", async () => {
    const { harness } = await loadPlugin("acme/widgets");

    await expect(harness.runCli(["repos"])).resolves.toEqual({
      exitCode: 0,
      stdout: "acme/widgets",
      stderr: "",
    });
    expect(
      harness.logEntries.filter((entry) =>
        entry.message.includes("extraRepos"),
      ),
    ).toEqual([]);
  });

  it("rejects malformed repositories as text and JSON and lists its commands in help", async () => {
    const { harness } = await loadPlugin();

    await expect(
      harness.runCli(["issues", "bad/repo/shape"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: 'Invalid repository "bad/repo/shape"; expected owner/repo.\n',
    });

    const failure = await harness.runCli([
      "issues",
      "bad/repo/shape",
      "--json",
    ]);
    expect(failure.exitCode).toBe(1);
    expect(JSON.parse(failure.stdout)).toEqual({
      ok: false,
      error: {
        code: "invalid_repository",
        message: 'Invalid repository "bad/repo/shape"; expected owner/repo.',
      },
    });

    const help = await harness.runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("bb github issues");
    expect(help.stdout).toContain("bb github sync");
  });

  it("rejects a malformed repository or item number when starting work", async () => {
    const { harness } = await loadPlugin();

    for (const input of [
      { repo: "not-a-repository", number: 1 },
      { repo: "acme/widgets", number: 0 },
    ]) {
      await expect(harness.callRpc("startWork", input)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
  });

  it("reports repositories, cached rows, and sync counts as JSON", async () => {
    const { harness } = await loadPlugin();

    const repos = await harness.runCli(["repos", "--json"]);
    expect(repos.exitCode).toBe(0);
    expect(JSON.parse(repos.stdout)).toEqual({
      ok: true,
      repos: [{ repo: "acme/widgets", projectId: null }],
      ignoredExtraRepos: [],
    });

    const sync = await harness.runCli(["sync", "--json"]);
    expect(sync.exitCode).toBe(0);
    expect(JSON.parse(sync.stdout)).toEqual({ ok: true, repos: 1, items: 2 });

    const issues = await harness.runCli(["issues", "acme/widgets", "--json"]);
    expect(issues.exitCode).toBe(0);
    const payload = JSON.parse(issues.stdout);
    expect(payload).toMatchObject({
      ok: true,
      items: [
        {
          repo: "acme/widgets",
          number: 7,
          kind: "issue",
          state: "OPEN",
          title: "Cache mutations",
          labels: ["bug", "old"],
        },
      ],
    });
    expect(payload.items[0]).not.toHaveProperty("body");
  });

  it("syncs, filters, mutates, and exposes the same cached issue across surfaces", async () => {
    const { harness } = await loadPlugin();

    await expect(harness.callRpc("refresh")).resolves.toEqual({
      repos: 1,
      items: 2,
    });
    await expect(
      harness.callRpc("listItems", {
        kind: "issue",
        state: "open",
        mine: true,
        query: "#7",
      }),
    ).resolves.toMatchObject({
      items: [
        {
          repo: "acme/widgets",
          number: 7,
          kind: "issue",
          labels: ["bug", "old"],
          assignees: ["octocat"],
        },
      ],
    });

    await expect(
      harness.callRpc("setAssignees", {
        repo: "acme/widgets",
        number: 7,
        assignees: ["octocat", "hubot", "hubot"],
      }),
    ).resolves.toEqual({
      ok: true,
      assignees: ["octocat", "hubot"],
    });
    await expect(
      harness.callRpc("setLabels", {
        repo: "acme/widgets",
        number: 7,
        labels: ["bug", "feature", "feature", " "],
      }),
    ).resolves.toEqual({ ok: true, labels: ["bug", "feature"] });

    expect(ghCalls()).toEqual(
      expect.arrayContaining([
        "issue edit 7 -R acme/widgets --add-assignee hubot",
        "issue edit 7 -R acme/widgets --add-label feature --remove-label old",
      ]),
    );
    await expect(
      harness.callRpc("listItems", { kind: "issue" }),
    ).resolves.toMatchObject({
      items: [
        {
          number: 7,
          labels: ["bug", "feature"],
          assignees: ["octocat", "hubot"],
        },
      ],
    });

    await expect(harness.runCli(["issues", "acme/widgets"])).resolves.toEqual({
      exitCode: 0,
      stdout: "acme/widgets#7\t[OPEN]\tCache mutations",
      stderr: "",
    });
    const issueProvider = harness.registrations.mentionProviders.find(
      (provider) => provider.id === "issue",
    );
    if (issueProvider === undefined) {
      throw new Error("GitHub issue mention provider was not registered");
    }
    expect(
      issueProvider.search({
        query: "cache",
        trigger: "@",
        projectId: "project-1",
        threadId: "thread-1",
      }),
    ).toEqual([
      {
        id: "acme/widgets#7",
        title: "#7 Cache mutations",
        subtitle: "acme/widgets",
      },
    ]);
    await expect(
      issueProvider.resolve("acme/widgets#7"),
    ).resolves.toMatchObject({
      context: expect.stringContaining("Live issue body."),
    });
    expect(
      harness.realtimeSignals.filter(
        (signal) => signal.channel === "data-changed",
      ),
    ).toHaveLength(3);
  });

  it("normalizes draft state, checks, review threads, and paginated files", async () => {
    const { harness } = await loadPlugin();

    await expect(
      harness.callRpc("getPull", { repo: "acme/widgets", number: 42 }),
    ).resolves.toMatchObject({
      pull: {
        repo: "acme/widgets",
        number: 42,
        state: "DRAFT",
        changedFiles: 2,
        reviewRequests: ["reviewer", "core-team"],
        checks: [
          { name: "build", status: "success" },
          { name: "legacy", status: "failure" },
          { name: "queued", status: "pending" },
          { name: "skipped", status: "neutral" },
        ],
        reviewThreads: [
          {
            path: "src/index.ts",
            line: 9,
            comments: [
              { author: "reviewer", body: "Root comment" },
              { author: "bob", body: "Reply" },
            ],
          },
          {
            path: "src/other.ts",
            line: 4,
            comments: [{ author: "reviewer", body: "Second thread" }],
          },
        ],
        files: [
          {
            path: "src/index.ts",
            status: "modified",
            patch: "@@ -1 +1 @@",
          },
          { path: "src/other.ts", status: "added", patch: null },
        ],
      },
    });
  });
});

describe("github plugin # mentions", () => {
  const GADGETS = "acme/gadgets";
  const SLOW_LOOKUP_MS = 3_000;
  const PARALLEL_LOOKUP_MS = 1_000;
  let fixturePath: string;

  interface Fixtures {
    graphql: Record<string, unknown>;
    exact: Record<string, { out?: string; err?: string; sleepMs?: number }>;
  }

  let fixtures: Fixtures;

  function setFixtures(next: Partial<Fixtures>) {
    fixtures = { graphql: {}, exact: {}, ...next };
    writeFileSync(fixturePath, JSON.stringify(fixtures));
  }

  function node(
    number: number,
    state: "OPEN" | "CLOSED" | "MERGED",
    updatedAt: string,
    repo = GADGETS,
  ) {
    return {
      number,
      title: `Item ${number}`,
      state,
      author: { login: "alice", id: "user-alice" },
      labels: { nodes: [] },
      assignees: { nodes: [] },
      url: `https://github.com/${repo}/issues/${number}`,
      body: "",
      updatedAt,
    };
  }

  function lists(parts: {
    openIssues?: unknown[];
    closedIssues?: unknown[];
    openPrs?: unknown[];
    closedPrs?: unknown[];
  }) {
    return {
      data: {
        repository: {
          hasIssuesEnabled: true,
          openIssues: { nodes: parts.openIssues ?? [] },
          closedIssues: { nodes: parts.closedIssues ?? [] },
          openPrs: { nodes: parts.openPrs ?? [] },
          closedPrs: { nodes: parts.closedPrs ?? [] },
        },
      },
    };
  }

  function issuesEndpoint(repo: string, number: number) {
    return `api --method GET repos/${repo}/issues/${number}`;
  }

  function pullsEndpoint(repo: string, number: number) {
    return `api --method GET repos/${repo}/pulls/${number}`;
  }

  function restItem(
    number: number,
    extra: Record<string, unknown> = {},
    state = "closed",
  ) {
    return JSON.stringify({
      number,
      title: `Widget handler bindings ${number}`,
      state,
      html_url: `https://github.com/${GADGETS}/issues/${number}`,
      ...extra,
    });
  }

  function apiGetCalls(): string[] {
    return ghCalls().filter((call) => call.startsWith("api --method GET"));
  }

  let checkoutCount = 0;

  function originRepo(url: string): string {
    checkoutCount += 1;
    const dir = join(binDir, "checkouts", String(checkoutCount));
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
    return dir;
  }

  type MentionSearch = (
    query: string,
    projectId?: string | null,
  ) => Promise<{ id: string; title: string; subtitle?: string }[]>;

  async function loadMentions(
    projects: { id: string; remotes: string[] }[],
    extraRepos = "",
  ): Promise<{
    host: Awaited<ReturnType<typeof loadPlugin>>;
    issues: MentionSearch;
    prs: MentionSearch;
    atIssues: MentionSearch;
    projectListCalls: () => number;
  }> {
    const projectList = projects.map((project) => ({
      id: project.id,
      sources: project.remotes.map((url) => ({
        type: "local_path",
        path: originRepo(url),
      })),
    }));
    const host = createFakePluginHost({
      pluginId: "github",
      settings: { extraRepos },
    });
    let projectListCalls = 0;
    host.harness.sdk.stub("projects.list", async () => {
      projectListCalls += 1;
      return projectList;
    });
    await plugin(host.bb);
    const searcher =
      (id: string, trigger: "#" | "@"): MentionSearch =>
      async (query, projectId = projects[0]?.id ?? null) => {
        const provider = host.harness.registrations.mentionProviders.find(
          (candidate) => candidate.id === id,
        );
        if (provider === undefined) throw new Error(`no ${id} provider`);
        return await provider.search({
          query,
          trigger,
          projectId,
          threadId: null,
        });
      };
    return {
      host,
      issues: searcher("issue", "#"),
      prs: searcher("pr", "#"),
      atIssues: searcher("issue", "@"),
      projectListCalls: () => projectListCalls,
    };
  }

  beforeEach(() => {
    fixturePath = join(binDir, "fixtures.json");
    setFixtures({});
    restoreEnv();
    restoreEnv = installFakeGh(
      binDir,
      `const callLog = ${JSON.stringify(callLog)};
const joined = args.join(" ");
fs.appendFileSync(callLog, joined + "\\n");
const fx = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
const empty = { data: { repository: { hasIssuesEnabled: true, openIssues: { nodes: [] }, closedIssues: { nodes: [] }, openPrs: { nodes: [] }, closedPrs: { nodes: [] } } } };
if (joined === "--version") {
  out("gh version 2.96.0 (fake)\\n");
} else if (joined.startsWith("api graphql ")) {
  const value = (key) => args.find((arg) => arg.startsWith(key + "="))?.slice(key.length + 1);
  out(JSON.stringify(fx.graphql[value("owner") + "/" + value("name")] ?? empty) + "\\n");
} else if (fx.exact[joined] !== undefined) {
  const hit = fx.exact[joined];
  if (hit.sleepMs) sleepMs(hit.sleepMs);
  if (hit.err !== undefined) {
    err(hit.err);
    process.exit(1);
  }
  out((hit.out ?? "") + "\\n");
} else if (joined.startsWith("auth status")) {
  out("authenticated\\n");
} else {
  out("[]\\n");
}`,
    );
  });

  it("returns cached closed items ranked by exact number, open, current project, then recency", async () => {
    setFixtures({
      graphql: {
        [GADGETS]: lists({
          openIssues: [node(16, "OPEN", "2026-01-02T00:00:00Z")],
          closedIssues: [
            node(6, "CLOSED", "2026-01-01T00:00:00Z"),
            node(64, "CLOSED", "2026-03-04T00:00:00Z"),
            node(61, "CLOSED", "2026-03-01T00:00:00Z"),
          ],
        }),
        "other/repo": lists({
          closedIssues: [
            node(6, "CLOSED", "2026-05-01T00:00:00Z", "other/repo"),
            node(65, "CLOSED", "2026-05-02T00:00:00Z", "other/repo"),
          ],
        }),
      },
    });
    const { host, issues } = await loadMentions(
      [{ id: "proj-gadgets", remotes: [`https://github.com/${GADGETS}.git`] }],
      "other/repo",
    );
    await host.harness.callRpc("refresh");

    const ranked = await issues("#6");
    expect(ranked.map((item) => item.id)).toEqual([
      "acme/gadgets#6",
      "other/repo#6",
      "acme/gadgets#16",
      "acme/gadgets#64",
      "acme/gadgets#61",
      "other/repo#65",
    ]);
    expect(ranked[0]).toEqual({
      id: "acme/gadgets#6",
      title: "#6 Item 6",
      subtitle: "acme/gadgets · closed",
    });
    expect(ranked[2]?.subtitle).toBe("acme/gadgets");

    const unscoped = await issues("#6", null);
    expect(unscoped.slice(0, 2).map((item) => item.id)).toEqual([
      "other/repo#6",
      "acme/gadgets#6",
    ]);
    expect(apiGetCalls()).toEqual([]);
  });

  it("keeps @ open-only and never looks up live items", async () => {
    setFixtures({
      graphql: {
        [GADGETS]: lists({
          openIssues: [node(16, "OPEN", "2026-01-02T00:00:00Z")],
          closedIssues: [node(61, "CLOSED", "2026-03-01T00:00:00Z")],
        }),
      },
    });
    const { host, atIssues } = await loadMentions([
      { id: "proj-gadgets", remotes: [`https://github.com/${GADGETS}.git`] },
    ]);
    await host.harness.callRpc("refresh");

    expect(await atIssues("6")).toEqual([
      { id: "acme/gadgets#16", title: "#16 Item 16", subtitle: GADGETS },
    ]);
    expect(await atIssues("59")).toEqual([]);
    expect(apiGetCalls()).toEqual([]);
  });

  it("looks up an uncached number once across both providers", async () => {
    setFixtures({
      exact: { [issuesEndpoint(GADGETS, 59)]: { out: restItem(59) } },
    });
    const { host, issues, prs } = await loadMentions([
      { id: "proj-gadgets", remotes: [`https://github.com/${GADGETS}.git`] },
    ]);
    await host.harness.callRpc("refresh");

    const [issueHits, prHits] = await Promise.all([issues("#59"), prs("#59")]);
    expect(issueHits).toEqual([
      {
        id: "acme/gadgets#59",
        title: "#59 Widget handler bindings 59",
        subtitle: "acme/gadgets · closed",
      },
    ]);
    expect(prHits).toEqual([]);
    expect(apiGetCalls()).toEqual([issuesEndpoint(GADGETS, 59)]);
  });

  it("marks a live merged pull request and gives it only to the PR provider", async () => {
    setFixtures({
      exact: {
        [issuesEndpoint(GADGETS, 59)]: {
          out: restItem(59, {
            pull_request: { merged_at: "2026-06-01T00:00:00Z" },
          }),
        },
      },
    });
    const { host, issues, prs } = await loadMentions([
      { id: "proj-gadgets", remotes: [`https://github.com/${GADGETS}.git`] },
    ]);
    await host.harness.callRpc("refresh");

    expect(await prs("59")).toEqual([
      {
        id: "acme/gadgets#59",
        title: "#59 Widget handler bindings 59",
        subtitle: "acme/gadgets · merged",
      },
    ]);
    expect(await issues("59")).toEqual([]);
    expect(apiGetCalls()).toHaveLength(1);
  });

  it("normalizes leading zeros and never goes live for non-numeric, zero, or huge queries", async () => {
    setFixtures({
      graphql: {
        [GADGETS]: lists({
          closedIssues: [node(7, "CLOSED", "2026-01-01T00:00:00Z")],
        }),
      },
    });
    const { host, issues } = await loadMentions([
      { id: "proj-gadgets", remotes: [`https://github.com/${GADGETS}.git`] },
    ]);
    await host.harness.callRpc("refresh");

    expect((await issues("#007")).map((item) => item.id)).toEqual([
      "acme/gadgets#7",
    ]);
    for (const query of ["59a", "0", "#0", "12345678901234"]) {
      await issues(query);
    }
    expect(apiGetCalls()).toEqual([]);
  });

  it("returns cached rows within budget when gh is slow, then serves the memoized hit", async () => {
    setFixtures({
      graphql: {
        [GADGETS]: lists({
          closedIssues: [node(159, "CLOSED", "2026-01-01T00:00:00Z")],
        }),
      },
      exact: {
        [issuesEndpoint(GADGETS, 59)]: {
          out: restItem(59),
          sleepMs: SLOW_LOOKUP_MS,
        },
      },
    });
    const { host, issues } = await loadMentions([
      { id: "proj-gadgets", remotes: [`https://github.com/${GADGETS}.git`] },
    ]);
    await host.harness.callRpc("refresh");

    const startedAt = Date.now();
    const first = await issues("59");
    expect(Date.now() - startedAt).toBeLessThan(SLOW_LOOKUP_MS);
    expect(first.map((item) => item.id)).toEqual(["acme/gadgets#159"]);
    expect(apiGetCalls()).toEqual([issuesEndpoint(GADGETS, 59)]);

    await vi.waitFor(
      async () => {
        expect((await issues("59")).map((item) => item.id)).toEqual([
          "acme/gadgets#59",
          "acme/gadgets#159",
        ]);
      },
      { timeout: 8_000, interval: 100 },
    );
    expect(apiGetCalls()).toHaveLength(1);
  }, 15_000);

  it("keeps cached rows on every failure kind, retries transient failures, and memoizes a 404", async () => {
    setFixtures({
      graphql: {
        [GADGETS]: lists({
          closedIssues: [node(12345, "CLOSED", "2026-01-01T00:00:00Z")],
        }),
      },
      exact: {
        [issuesEndpoint(GADGETS, 12)]: { out: "not json" },
        [issuesEndpoint(GADGETS, 23)]: { out: restItem(99) },
        [issuesEndpoint(GADGETS, 34)]: {
          out: JSON.stringify({ number: 34, state: "closed" }),
        },
        [issuesEndpoint(GADGETS, 45)]: { err: "gh: Bad Gateway (HTTP 502)" },
        [issuesEndpoint(GADGETS, 123)]: { err: "gh: Not Found (HTTP 404)" },
      },
    });
    const { host, issues } = await loadMentions([
      { id: "proj-gadgets", remotes: [`https://github.com/${GADGETS}.git`] },
    ]);
    await host.harness.callRpc("refresh");

    const queries = ["12", "23", "34", "45", "123"];
    for (const query of queries) {
      expect((await issues(query)).map((item) => item.id)).toEqual([
        "acme/gadgets#12345",
      ]);
    }
    expect(apiGetCalls()).toHaveLength(5);

    for (const query of queries) {
      expect((await issues(query)).map((item) => item.id)).toEqual([
        "acme/gadgets#12345",
      ]);
    }
    expect(apiGetCalls()).toHaveLength(9);
    expect(
      apiGetCalls().filter((call) => call === issuesEndpoint(GADGETS, 123)),
    ).toHaveLength(1);
  });

  it("falls back to the pulls endpoint on HTTP 410 and reads its top-level merged_at", async () => {
    setFixtures({
      exact: {
        [issuesEndpoint(GADGETS, 59)]: {
          err: "gh: Issues are disabled for this repo (HTTP 410)",
        },
        [pullsEndpoint(GADGETS, 59)]: {
          out: restItem(59, { merged_at: "2026-06-01T00:00:00Z" }),
        },
      },
    });
    const { host, issues, prs } = await loadMentions([
      { id: "proj-gadgets", remotes: [`https://github.com/${GADGETS}.git`] },
    ]);
    await host.harness.callRpc("refresh");

    expect(await prs("59")).toEqual([
      {
        id: "acme/gadgets#59",
        title: "#59 Widget handler bindings 59",
        subtitle: "acme/gadgets · merged",
      },
    ]);
    expect(await issues("59")).toEqual([]);
    expect(apiGetCalls()).toEqual([
      issuesEndpoint(GADGETS, 59),
      pullsEndpoint(GADGETS, 59),
    ]);
  });

  it("looks up every repo of a project in parallel, puts live hits first, and caps at 8 rows", async () => {
    const OTHER = "acme/other";
    setFixtures({
      graphql: {
        [GADGETS]: lists({
          closedIssues: Array.from({ length: 9 }, (_, index) =>
            node(1590 + index, "CLOSED", `2026-02-0${index + 1}T00:00:00Z`),
          ),
        }),
      },
      exact: {
        [issuesEndpoint(GADGETS, 59)]: {
          out: restItem(59),
          sleepMs: PARALLEL_LOOKUP_MS,
        },
        [issuesEndpoint(OTHER, 59)]: {
          out: JSON.stringify({
            number: 59,
            title: "Merged elsewhere",
            state: "closed",
            html_url: `https://github.com/${OTHER}/pull/59`,
            pull_request: { merged_at: "2026-06-01T00:00:00Z" },
          }),
          sleepMs: PARALLEL_LOOKUP_MS,
        },
      },
    });
    const { host, issues, prs } = await loadMentions([
      {
        id: "proj-multi",
        remotes: [
          `https://github.com/${GADGETS}.git`,
          `git@github.com:${OTHER}.git`,
        ],
      },
    ]);
    await host.harness.callRpc("refresh");

    const [issueHits, prHits] = await Promise.all([issues("59"), prs("59")]);
    expect(apiGetCalls().sort()).toEqual([
      issuesEndpoint(GADGETS, 59),
      issuesEndpoint(OTHER, 59),
    ]);
    expect(issueHits).toHaveLength(8);
    expect(issueHits[0]?.id).toBe("acme/gadgets#59");
    expect(prHits).toEqual([
      {
        id: "acme/other#59",
        title: "#59 Merged elsewhere",
        subtitle: "acme/other · merged",
      },
    ]);
  });

  it("gives live lookup to every project sharing a repository", async () => {
    setFixtures({
      exact: { [issuesEndpoint(GADGETS, 59)]: { out: restItem(59) } },
    });
    const { host, issues } = await loadMentions([
      { id: "proj-a", remotes: [`https://github.com/${GADGETS}.git`] },
      { id: "proj-b", remotes: [`https://github.com/${GADGETS}.git`] },
    ]);
    await host.harness.callRpc("refresh");

    expect((await issues("59", "proj-a")).map((item) => item.id)).toEqual([
      "acme/gadgets#59",
    ]);
    expect((await issues("59", "proj-b")).map((item) => item.id)).toEqual([
      "acme/gadgets#59",
    ]);
    expect(apiGetCalls()).toHaveLength(1);
  });

  it("makes no lookup without a project, for unattached repos, or when gh is not ready", async () => {
    setFixtures({
      exact: { [issuesEndpoint(GADGETS, 59)]: { out: restItem(59) } },
    });
    const { host, issues } = await loadMentions(
      [{ id: "proj-gadgets", remotes: [`https://github.com/${GADGETS}.git`] }],
      "acme/widgets",
    );
    await host.harness.callRpc("refresh");

    expect(await issues("59", null)).toEqual([]);
    expect(await issues("59", "proj-unknown")).toEqual([]);
    expect(apiGetCalls()).toEqual([]);

    setFixtures({
      exact: {
        "auth status --hostname github.com --active": {
          err: "transient failure",
        },
        [issuesEndpoint(GADGETS, 59)]: { out: restItem(59) },
      },
    });
    const notReady = await loadMentions([
      { id: "proj-gadgets", remotes: [`https://github.com/${GADGETS}.git`] },
    ]);
    await notReady.host.harness.callRpc("status");
    expect(await notReady.issues("59")).toEqual([]);
    expect(apiGetCalls()).toEqual([]);
  });

  it("looks up only the project repos that lack a cached row for the number", async () => {
    const OTHER = "acme/other";
    setFixtures({
      graphql: {
        [GADGETS]: lists({
          closedIssues: [node(59, "CLOSED", "2026-01-01T00:00:00Z")],
        }),
      },
      exact: {
        [issuesEndpoint(OTHER, 59)]: {
          out: JSON.stringify({
            number: 59,
            title: "Other widget",
            state: "closed",
            html_url: `https://github.com/${OTHER}/issues/59`,
          }),
        },
      },
    });
    const { host, issues } = await loadMentions([
      {
        id: "proj-multi",
        remotes: [
          `https://github.com/${GADGETS}.git`,
          `git@github.com:${OTHER}.git`,
        ],
      },
    ]);
    await host.harness.callRpc("refresh");

    expect((await issues("59")).map((item) => item.id)).toEqual([
      "acme/other#59",
      "acme/gadgets#59",
    ]);
    expect(apiGetCalls()).toEqual([issuesEndpoint(OTHER, 59)]);
  });

  it("does not block on a cold repo cache and looks up live once repos are discovered", async () => {
    setFixtures({
      exact: { [issuesEndpoint(GADGETS, 59)]: { out: restItem(59) } },
    });
    const { issues, projectListCalls } = await loadMentions([
      { id: "proj-gadgets", remotes: [`https://github.com/${GADGETS}.git`] },
    ]);

    expect(await Promise.all([issues("59"), issues("59")])).toEqual([[], []]);
    expect(apiGetCalls()).toEqual([]);
    expect(projectListCalls()).toBe(1);

    await vi.waitFor(
      async () => {
        expect((await issues("59")).map((item) => item.id)).toEqual([
          "acme/gadgets#59",
        ]);
      },
      { timeout: 5_000, interval: 50 },
    );
    expect(apiGetCalls()).toEqual([issuesEndpoint(GADGETS, 59)]);
    expect(projectListCalls()).toBe(1);
  });

  it("never looks up a repo whose path has a dot segment", async () => {
    setFixtures({
      exact: {
        [issuesEndpoint("../..", 59)]: { out: restItem(59) },
        [issuesEndpoint("acme/..", 59)]: { out: restItem(59) },
      },
    });
    const { host, issues } = await loadMentions([
      {
        id: "proj-unsafe",
        remotes: ["https://github.com/../..", "https://github.com/acme/.."],
      },
    ]);
    await host.harness.callRpc("refresh");

    expect(await issues("59")).toEqual([]);
    expect(apiGetCalls()).toEqual([]);
  });

  it("labels a cached merged pull request and shows a live open item with the bare repo subtitle", async () => {
    setFixtures({
      graphql: {
        [GADGETS]: lists({
          closedPrs: [node(80, "MERGED", "2026-01-01T00:00:00Z")],
        }),
      },
      exact: {
        [issuesEndpoint(GADGETS, 59)]: {
          out: restItem(59, {}, "open"),
        },
      },
    });
    const { host, issues, prs } = await loadMentions([
      { id: "proj-gadgets", remotes: [`https://github.com/${GADGETS}.git`] },
    ]);
    await host.harness.callRpc("refresh");

    expect(await prs("#80")).toEqual([
      {
        id: "acme/gadgets#80",
        title: "#80 Item 80",
        subtitle: "acme/gadgets · merged",
      },
    ]);
    expect(await issues("#59")).toEqual([
      {
        id: "acme/gadgets#59",
        title: "#59 Widget handler bindings 59",
        subtitle: GADGETS,
      },
    ]);
  });

  it("returns the fast repo's live hit even when another repo's lookup times out", async () => {
    const SLOW = "acme/slow";
    setFixtures({
      exact: {
        [issuesEndpoint(GADGETS, 59)]: { out: restItem(59) },
        [issuesEndpoint(SLOW, 59)]: {
          out: restItem(59),
          sleepMs: SLOW_LOOKUP_MS,
        },
      },
    });
    const { host, issues } = await loadMentions([
      {
        id: "proj-mixed",
        remotes: [
          `https://github.com/${GADGETS}.git`,
          `git@github.com:${SLOW}.git`,
        ],
      },
    ]);
    await host.harness.callRpc("refresh");

    const startedAt = Date.now();
    const hits = await issues("59");
    expect(Date.now() - startedAt).toBeLessThan(SLOW_LOOKUP_MS);
    expect(hits.map((item) => item.id)).toEqual(["acme/gadgets#59"]);
    expect(apiGetCalls().sort()).toEqual([
      issuesEndpoint(GADGETS, 59),
      issuesEndpoint(SLOW, 59),
    ]);
  });
});

describe("github plugin multi-account reads", () => {
  const HIDDEN = "acme/hidden";
  const OPEN = "acme/open";
  const ACTIVE = "active";
  const BACKUP_LOGIN = "backup";
  const BACKUP_TOKEN = "token-backup";
  const HOSTS_CALL = "auth status --hostname github.com --json hosts";
  const TOKEN_CALL = "auth token --hostname github.com --user backup";
  const HIDDEN_REPO_CHECK = `api repos/${HIDDEN} --silent`;
  const NOT_FOUND = "gh: Not Found (HTTP 404)";
  const GRAPHQL_MISSING = (repo: string) =>
    `Could not resolve to a Repository named '${repo}' (repository)`;

  interface GhSpec {
    out?: string;
    err?: string;
    exitCode?: number;
    sleepMs?: number;
  }
  interface MultiAccountFixtures {
    hosts?: GhSpec;
    tokens?: Record<string, string | null>;
    graphql?: Record<string, Record<string, GhSpec>>;
    repoCheck?: Record<string, Record<string, GhSpec>>;
    rest?: Record<string, Record<string, GhSpec>>;
    cli?: Record<string, Record<string, GhSpec>>;
  }

  let fixturePath: string;
  let fixtures: MultiAccountFixtures;

  function writeFixtures() {
    writeFileSync(fixturePath, JSON.stringify(fixtures));
  }

  function resetFixtures(next: MultiAccountFixtures = {}) {
    fixtures = next;
    writeFixtures();
  }

  function mergeTables(
    left: Record<string, Record<string, GhSpec>> | undefined,
    right: Record<string, Record<string, GhSpec>> | undefined,
  ): Record<string, Record<string, GhSpec>> {
    const merged: Record<string, Record<string, GhSpec>> = { ...left };
    for (const [identity, table] of Object.entries(right ?? {})) {
      merged[identity] = { ...merged[identity], ...table };
    }
    return merged;
  }

  function updateFixtures(next: MultiAccountFixtures) {
    const tokens = { ...fixtures.tokens, ...next.tokens };
    fixtures = {
      hosts: next.hosts ?? fixtures.hosts,
      ...(Object.keys(tokens).length > 0 ? { tokens } : {}),
      graphql: mergeTables(fixtures.graphql, next.graphql),
      repoCheck: mergeTables(fixtures.repoCheck, next.repoCheck),
      rest: mergeTables(fixtures.rest, next.rest),
      cli: mergeTables(fixtures.cli, next.cli),
    };
    writeFixtures();
  }

  function issueJson(title = "Hidden issue") {
    return JSON.stringify({
      number: 5,
      title,
      state: "OPEN",
      author: { login: "alice" },
      labels: [{ name: "bug" }],
      assignees: [],
      url: `https://github.com/${HIDDEN}/issues/5`,
      body: "Hidden body.",
      updatedAt: "2026-09-01T00:00:00Z",
      comments: [],
    });
  }

  function graphqlLists(repo: string) {
    const node = (number: number, kind: "issue" | "pr") => ({
      number,
      title: `${kind === "pr" ? "PR" : "Issue"} ${number}`,
      state: "OPEN",
      author: { login: kind === "pr" ? "bob" : "alice", id: "user-x" },
      labels: { nodes: [] },
      assignees: { nodes: [] },
      url: `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`,
      body: "",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    return JSON.stringify({
      data: {
        repository: {
          hasIssuesEnabled: true,
          openIssues: { nodes: [node(5, "issue")] },
          closedIssues: { nodes: [] },
          openPrs: { nodes: [node(6, "pr")] },
          closedPrs: { nodes: [] },
        },
      },
    });
  }

  function restItemJson(repo: string, number: number) {
    return JSON.stringify({
      number,
      title: `Item ${number}`,
      state: "open",
      html_url: `https://github.com/${repo}/issues/${number}`,
    });
  }

  function hiddenReadFixtures(): MultiAccountFixtures {
    return {
      graphql: {
        [ACTIVE]: { [HIDDEN]: { err: GRAPHQL_MISSING(HIDDEN) } },
        [BACKUP_TOKEN]: { [HIDDEN]: { out: graphqlLists(HIDDEN) } },
      },
      repoCheck: {
        [ACTIVE]: { [HIDDEN]: { err: NOT_FOUND } },
        [BACKUP_TOKEN]: { [HIDDEN]: { out: "{}" } },
      },
      cli: {
        [ACTIVE]: {
          [`issue view -R ${HIDDEN}`]: { err: GRAPHQL_MISSING(HIDDEN) },
        },
        [BACKUP_TOKEN]: { [`issue view -R ${HIDDEN}`]: { out: issueJson() } },
      },
    };
  }

  function identityCalls(identity: string): string[] {
    const prefix = `[${identity}] `;
    return ghCalls()
      .filter((call) => call.startsWith(prefix))
      .map((call) => call.slice(prefix.length));
  }

  function callsFor(identity: string, fragment: string): string[] {
    return identityCalls(identity).filter((call) => call.includes(fragment));
  }

  let checkoutCount = 0;

  function originRepo(url: string): string {
    checkoutCount += 1;
    const dir = join(binDir, "checkouts", String(checkoutCount));
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
    return dir;
  }

  type MentionSearch = (
    query: string,
  ) => Promise<{ id: string; title: string; subtitle?: string }[]>;

  async function loadMultiAccount(
    options: {
      projects?: { id: string; repos: string[] }[];
      extraRepos?: string;
      firstProjectsListDelayMs?: number;
      projectsListRepeatDelayMs?: number;
    } = {},
  ) {
    const projectList = (options.projects ?? []).map((project) => ({
      id: project.id,
      sources: project.repos.map((repo) => ({
        type: "local_path",
        path: originRepo(`https://github.com/${repo}.git`),
      })),
    }));
    const host = createFakePluginHost({
      pluginId: "github",
      settings: { extraRepos: options.extraRepos ?? "" },
    });
    let projectsListCalls = 0;
    host.harness.sdk.stub("projects.list", async () => {
      projectsListCalls += 1;
      const delay =
        projectsListCalls === 1
          ? (options.firstProjectsListDelayMs ?? 0)
          : (options.projectsListRepeatDelayMs ?? 0);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return projectList;
    });
    await plugin(host.bb);
    const searcher =
      (id: string): MentionSearch =>
      async (query) => {
        const provider = host.harness.registrations.mentionProviders.find(
          (candidate) => candidate.id === id,
        );
        if (provider === undefined) throw new Error(`no ${id} provider`);
        return (await provider.search({
          query,
          trigger: "#",
          projectId: options.projects?.[0]?.id ?? null,
          threadId: null,
        })) as { id: string; title: string; subtitle?: string }[];
      };
    return {
      harness: host.harness,
      issues: searcher("issue"),
      dispose: () => host.harness.lifecycle.dispose(),
    };
  }

  beforeEach(() => {
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
    vi.mocked(experimental_runVcsProcess).mockClear();
    fixturePath = join(binDir, "multi-account-fixtures.json");
    resetFixtures();
    restoreEnv();
    restoreEnv = installFakeGh(
      binDir,
      `const callLog = ${JSON.stringify(callLog)};
const fixturePath = ${JSON.stringify(fixturePath)};
const joined = args.join(" ");
const identity = process.env.GH_TOKEN === undefined ? "active" : process.env.GH_TOKEN;
fs.appendFileSync(callLog, "[" + identity + "] " + joined + "\\n");
const fx = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const emit = (spec) => {
  if (spec === undefined || spec === null) { out("[]\\n"); return; }
  if (spec.sleepMs) sleepMs(spec.sleepMs);
  if (spec.err !== undefined) { err(spec.err + "\\n"); process.exit(1); }
  if (spec.exitCode !== undefined && spec.exitCode !== 0) {
    out((spec.out ?? "") + "\\n");
    process.exit(spec.exitCode);
  }
  out((spec.out ?? "") + "\\n");
};
const forIdentity = (table) => ((table ?? {})[identity] ?? {});
if (joined === "--version") {
  emit({ out: "gh version 2.96.0 (fake)" });
} else if (joined === "auth status --hostname github.com --active") {
  emit({ out: "authenticated" });
} else if (joined === "auth status --hostname github.com --json hosts") {
  emit(fx.hosts ?? { out: JSON.stringify({ hosts: { "github.com": [{ login: "lead", active: true, state: "success" }, { login: "backup", active: false, state: "success" }] } }) });
} else if (args[0] === "auth" && args[1] === "token") {
  const token = (fx.tokens ?? { backup: "token-backup" })[args[args.length - 1]];
  if (token === undefined || token === null) {
    err("no oauth token found for github.com\\n");
    process.exit(1);
  }
  out(token + "\\n");
} else if (args[0] === "api" && args[1] === "user") {
  emit({ out: '{"login":"lead"}' });
} else if (args[0] === "api" && args[1] === "graphql") {
  const value = (key) => args.find((arg) => arg.startsWith(key + "="))?.slice(key.length + 1);
  emit(forIdentity(fx.graphql)[value("owner") + "/" + value("name")]);
} else if (args[0] === "api" && args[1]?.startsWith("repos/") && args.includes("--silent")) {
  emit(forIdentity(fx.repoCheck)[args[1].slice("repos/".length)]);
} else if (args[0] === "api" && args[1] === "--method") {
  emit(forIdentity(fx.rest)[joined]);
} else if (args[0] === "issue" || args[0] === "pr") {
  const repo = args[args.indexOf("-R") + 1] ?? "";
  const table = forIdentity(fx.cli);
  emit(table[joined] ?? table[args[0] + " " + args[1] + " -R " + repo]);
} else {
  emit(undefined);
}`,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("syncs a hidden repo as the other account, logs the binding once, and caches its items", async () => {
    resetFixtures(hiddenReadFixtures());
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });

    await expect(harness.callRpc("refresh")).resolves.toEqual({
      repos: 1,
      items: 2,
    });
    expect(
      harness.logEntries.filter(
        (entry) =>
          entry.level === "info" &&
          entry.message.startsWith("using gh account "),
      ),
    ).toEqual([
      expect.objectContaining({
        level: "info",
        message: `using gh account ${BACKUP_LOGIN} for ${HIDDEN}`,
      }),
    ]);
    await expect(
      harness.callRpc("listItems", { kind: "issue" }),
    ).resolves.toMatchObject({
      items: [{ repo: HIDDEN, number: 5, title: "Issue 5" }],
    });
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
    expect(callsFor(ACTIVE, HIDDEN_REPO_CHECK)).toHaveLength(1);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
  });

  it("looks up a live #N with the bound token after sync", async () => {
    resetFixtures({
      ...hiddenReadFixtures(),
      rest: {
        [ACTIVE]: {
          [`api --method GET repos/${HIDDEN}/issues/59`]: { err: NOT_FOUND },
        },
        [BACKUP_TOKEN]: {
          [`api --method GET repos/${HIDDEN}/issues/59`]: {
            out: restItemJson(HIDDEN, 59),
          },
        },
      },
    });
    const { harness, issues } = await loadMultiAccount({
      projects: [{ id: "proj-hidden", repos: [HIDDEN] }],
      extraRepos: HIDDEN,
    });
    await harness.callRpc("refresh");

    expect(await issues("#59")).toEqual([
      {
        id: `${HIDDEN}#59`,
        title: "#59 Item 59",
        subtitle: HIDDEN,
      },
    ]);
    expect(callsFor(ACTIVE, `repos/${HIDDEN}/issues/59`)).toHaveLength(0);
    expect(callsFor(BACKUP_TOKEN, `repos/${HIDDEN}/issues/59`)).toHaveLength(1);
  });

  it("starts exactly one probe for parallel unknown-repo lookups", async () => {
    resetFixtures({
      ...hiddenReadFixtures(),
      rest: {
        [ACTIVE]: {
          [`api --method GET repos/${HIDDEN}/issues/59`]: { err: NOT_FOUND },
          [`api --method GET repos/${HIDDEN}/issues/60`]: { err: NOT_FOUND },
        },
        [BACKUP_TOKEN]: {
          [`api --method GET repos/${HIDDEN}/issues/59`]: {
            out: restItemJson(HIDDEN, 59),
          },
          [`api --method GET repos/${HIDDEN}/issues/60`]: {
            out: restItemJson(HIDDEN, 60),
          },
        },
      },
    });
    const { harness, issues } = await loadMultiAccount({
      projects: [{ id: "proj-hidden", repos: [HIDDEN] }],
      extraRepos: HIDDEN,
    });
    await harness.callRpc("status");

    const [hit59, hit60] = await Promise.all([issues("#59"), issues("#60")]);
    expect(hit59.map((row) => row.id)).toEqual([`${HIDDEN}#59`]);
    expect(hit60.map((row) => row.id)).toEqual([`${HIDDEN}#60`]);
    expect(callsFor(ACTIVE, HIDDEN_REPO_CHECK)).toHaveLength(1);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(1);
  });

  it("binds a visible repo to the active account on a missing #N and never probes other accounts", async () => {
    const { harness, issues } = await loadMultiAccount({
      projects: [{ id: "proj-open", repos: [OPEN] }],
      extraRepos: OPEN,
    });
    await harness.callRpc("status");
    updateFixtures({
      repoCheck: { [ACTIVE]: { [OPEN]: { out: "{}" } } },
      rest: {
        [ACTIVE]: {
          [`api --method GET repos/${OPEN}/issues/59`]: { err: NOT_FOUND },
        },
      },
    });

    expect(await issues("#59")).toEqual([]);
    expect(callsFor(ACTIVE, `api repos/${OPEN} --silent`)).toHaveLength(1);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(0);
    expect(identityCalls(BACKUP_TOKEN)).toEqual([]);

    await harness.callRpc("commentIssue", {
      repo: OPEN,
      number: 59,
      body: "hello",
    });
    expect(callsFor(ACTIVE, `issue comment 59 -R ${OPEN}`)).toHaveLength(1);
    expect(identityCalls(BACKUP_TOKEN)).toEqual([]);
  });

  it("keeps writes on the active account and names the reading account in the write error", async () => {
    resetFixtures(hiddenReadFixtures());
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });

    updateFixtures({
      cli: {
        [ACTIVE]: { [`issue comment -R ${HIDDEN}`]: { err: NOT_FOUND } },
      },
    });
    await expect(
      harness.callRpc("commentIssue", { repo: HIDDEN, number: 5, body: "hi" }),
    ).rejects.toThrow(
      "the active gh account cannot see acme/hidden; bb reads it as backup " +
        "but writes only as the active account. gh error: " +
        "gh issue comment 5 failed: gh: Not Found (HTTP 404)",
    );
    expect(callsFor(ACTIVE, `issue comment 5 -R ${HIDDEN}`)).toHaveLength(1);
  });

  it("does not prefix write failures that are not not-found on an alternate repo", async () => {
    resetFixtures(hiddenReadFixtures());
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });

    updateFixtures({
      cli: {
        [ACTIVE]: {
          [`issue comment -R ${HIDDEN}`]: {
            err: "gh: Validation Failed (HTTP 422)",
          },
        },
      },
    });
    const error = await harness
      .callRpc("commentIssue", { repo: HIDDEN, number: 5, body: "hi" })
      .then(
        () => {
          throw new Error("expected commentIssue to reject");
        },
        (cause: unknown) => cause,
      );
    expect((error as Error).message).toContain("HTTP 422");
    expect((error as Error).message).not.toContain(
      "the active gh account cannot see",
    );
  });

  it("keeps the original error and reports the sync failure when nobody can see the repo", async () => {
    resetFixtures({
      graphql: {
        [ACTIVE]: {
          [HIDDEN]: { err: GRAPHQL_MISSING(HIDDEN) },
          [OPEN]: { out: graphqlLists(OPEN) },
        },
        [BACKUP_TOKEN]: { [HIDDEN]: { err: GRAPHQL_MISSING(HIDDEN) } },
      },
      repoCheck: {
        [ACTIVE]: { [HIDDEN]: { err: NOT_FOUND }, [OPEN]: { out: "{}" } },
        [BACKUP_TOKEN]: { [HIDDEN]: { err: NOT_FOUND } },
      },
    });
    const { harness } = await loadMultiAccount({
      extraRepos: `${HIDDEN},${OPEN}`,
    });

    await expect(harness.callRpc("refresh")).resolves.toEqual({
      repos: 2,
      items: 2,
    });
    expect(harness.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining(
            `sync failed for ${HIDDEN}: gh api graphql --hostname failed: Could not resolve to a Repository`,
          ),
        }),
      ]),
    );
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
  });

  it("never falls back on HTTP 500 and retries a transient probe failure on the next read", async () => {
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    updateFixtures({
      cli: {
        [ACTIVE]: {
          [`issue view -R ${HIDDEN}`]: {
            err: "gh: Internal Server Error (HTTP 500)",
          },
        },
      },
    });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/HTTP 500/);
    expect(identityCalls(BACKUP_TOKEN)).toEqual([]);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(0);
    expect(callsFor(ACTIVE, HIDDEN_REPO_CHECK)).toHaveLength(0);

    updateFixtures({
      cli: {
        [ACTIVE]: { [`issue view -R ${HIDDEN}`]: { err: NOT_FOUND } },
        [BACKUP_TOKEN]: { [`issue view -R ${HIDDEN}`]: { out: issueJson() } },
      },
      repoCheck: {
        [ACTIVE]: { [HIDDEN]: { err: NOT_FOUND } },
        [BACKUP_TOKEN]: { [HIDDEN]: { err: "gh: Bad Gateway (HTTP 502)" } },
      },
    });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/HTTP 404/);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);

    updateFixtures({
      repoCheck: { [BACKUP_TOKEN]: { [HIDDEN]: { out: "{}" } } },
    });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(2);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
  });

  it("treats an unparsable account list as unavailable until the next sync pass", async () => {
    resetFixtures({
      ...hiddenReadFixtures(),
      hosts: { out: "not json at all" },
      rest: {
        [ACTIVE]: {
          [`api --method GET repos/${HIDDEN}/issues/5`]: { err: NOT_FOUND },
        },
        [BACKUP_TOKEN]: {
          [`api --method GET repos/${HIDDEN}/issues/5`]: {
            out: restItemJson(HIDDEN, 5),
          },
        },
      },
    });
    const { harness, issues } = await loadMultiAccount({
      projects: [{ id: "proj-hidden", repos: [HIDDEN] }],
      extraRepos: HIDDEN,
    });
    await harness.callRpc("status");
    const unavailableWarn = () =>
      harness.logEntries.filter((entry) =>
        entry.message.includes(
          "gh auth status --json is not available; reading other gh accounts is turned off until the next sync",
        ),
      );

    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/Could not resolve to a Repository/);
    expect(await issues("#5")).toEqual([]);
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/Could not resolve to a Repository/);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
    expect(callsFor(ACTIVE, HIDDEN_REPO_CHECK)).toHaveLength(3);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(0);
    expect(unavailableWarn()).toHaveLength(1);

    fixtures.hosts = undefined;
    writeFixtures();
    await harness.callRpc("refresh");
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(2);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
    expect(unavailableWarn()).toHaveLength(1);
  });

  it("runs gh auth status once when the account list fails twice in the same pass", async () => {
    resetFixtures({
      ...hiddenReadFixtures(),
      hosts: { out: "not json at all" },
    });
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
      ).rejects.toThrow(/Could not resolve to a Repository/);
    }
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
  });

  it("re-fetches the alternate token at each sync pass and stops after logout", async () => {
    resetFixtures(hiddenReadFixtures());
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(1);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);

    const syncedCount = () =>
      harness.logEntries.filter(
        (entry) =>
          entry.level === "info" && entry.message.startsWith("synced "),
      ).length;
    const failedCount = () =>
      harness.logEntries.filter((entry) =>
        entry.message.includes(`sync failed for ${HIDDEN}`),
      ).length;
    const runPass = async (ready: () => boolean) => {
      const { controller, done } = harness.runService("sync");
      await vi.waitFor(() => expect(ready()).toBe(true), { timeout: 5_000 });
      controller.abort();
      await done;
    };

    await runPass(() => syncedCount() >= 1);
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(2);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
    expect(failedCount()).toBe(0);

    updateFixtures({ tokens: { [BACKUP_LOGIN]: null } });
    await runPass(() => failedCount() >= 1);
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(4);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/Could not resolve to a Repository/);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
  });

  it("stops reading a repo as the other account after it leaves extraRepos", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = hiddenReadFixtures();
    resetFixtures({
      ...base,
      graphql: {
        ...base.graphql,
        [ACTIVE]: {
          ...(base.graphql?.[ACTIVE] ?? {}),
          [OPEN]: { out: graphqlLists(OPEN) },
        },
      },
    });
    const { harness } = await loadMultiAccount({
      extraRepos: `${HIDDEN},${OPEN}`,
    });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);

    await harness.setSettings({ extraRepos: OPEN });
    vi.setSystemTime(Date.now() + 61_000);
    const { controller, done } = harness.runService("sync");
    await vi.waitFor(
      () =>
        expect(
          harness.logEntries.some(
            (entry) =>
              entry.level === "info" && entry.message.startsWith("synced "),
          ),
        ).toBe(true),
      { timeout: 5_000 },
    );
    controller.abort();
    await done;

    expect(callsFor(BACKUP_TOKEN, "api graphql")).toHaveLength(0);
    expect(callsFor(ACTIVE, "name=hidden")).toHaveLength(0);
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/Could not resolve to a Repository/);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
    expect(callsFor(BACKUP_TOKEN, `issue view 5 -R ${HIDDEN}`)).toHaveLength(1);
  });

  it("uses the fallback for a read whose repo name differs only in case", async () => {
    resetFixtures({
      repoCheck: {
        [ACTIVE]: { "ACME/HIDDEN": { err: NOT_FOUND } },
        [BACKUP_TOKEN]: { "ACME/HIDDEN": { out: "{}" } },
      },
      cli: {
        [ACTIVE]: {
          [`issue view -R ACME/HIDDEN`]: {
            err: GRAPHQL_MISSING("ACME/HIDDEN"),
          },
        },
        [BACKUP_TOKEN]: {
          [`issue view -R ACME/HIDDEN`]: { out: issueJson() },
        },
      },
    });
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: "ACME/HIDDEN", number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
    expect(
      callsFor(BACKUP_TOKEN, "api repos/ACME/HIDDEN --silent"),
    ).toHaveLength(1);
  });

  it("resolves an interactive read's account at interactive priority", async () => {
    resetFixtures(hiddenReadFixtures());
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });

    const prioritiesFor = (
      joined: string,
    ): (ExperimentalVcsProcessPriority | undefined)[] =>
      vi
        .mocked(experimental_runVcsProcess)
        .mock.calls.filter(([, args]) => args.join(" ") === joined)
        .map((call) => call[3]?.priority);

    expect(prioritiesFor(HIDDEN_REPO_CHECK)).toEqual([
      "interactive",
      "interactive",
    ]);
    expect(prioritiesFor(HOSTS_CALL)).toEqual(["interactive"]);
    expect(prioritiesFor(TOKEN_CALL)).toEqual(["interactive"]);
    expect(
      vi
        .mocked(experimental_runVcsProcess)
        .mock.calls.filter(([, args]) =>
          args.join(" ").startsWith(`issue view 5 -R ${HIDDEN}`),
        )
        .map((call) => call[3]?.priority),
    ).toEqual(["interactive", "interactive"]);
  });

  it("reads the account list from a failed gh auth status exit and uses the working candidate", async () => {
    resetFixtures({
      ...hiddenReadFixtures(),
      hosts: {
        exitCode: 1,
        out: JSON.stringify({
          hosts: {
            "github.com": [
              { login: "lead", active: true, state: "success" },
              { login: "ghost", active: false, state: "failure" },
              { login: BACKUP_LOGIN, active: false, state: "success" },
            ],
          },
        }),
      },
      tokens: { [BACKUP_LOGIN]: BACKUP_TOKEN },
    });
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });

    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
    expect(
      ghCalls().some((call) => call.includes("auth token --user ghost")),
    ).toBe(false);
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(1);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
  });

  it("never leaks the alternate token into a failed call's error", async () => {
    resetFixtures({
      ...hiddenReadFixtures(),
      cli: {
        [ACTIVE]: { [`issue view -R ${HIDDEN}`]: { err: NOT_FOUND } },
        [BACKUP_TOKEN]: {
          [`issue view -R ${HIDDEN}`]: {
            err: "gh: API rate limit exceeded (HTTP 403)",
          },
        },
      },
    });
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });

    const error = await harness
      .callRpc("getIssue", { repo: HIDDEN, number: 5 })
      .then(
        () => {
          throw new Error("expected getIssue to reject");
        },
        (cause: unknown) => cause,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 403");
    expect((error as Error).message).not.toContain(BACKUP_TOKEN);
  });

  it("drops the binding after a 401 and re-resolves on the next read", async () => {
    resetFixtures(hiddenReadFixtures());
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });

    updateFixtures({
      cli: {
        [BACKUP_TOKEN]: {
          [`issue view -R ${HIDDEN}`]: {
            err: "gh: Bad credentials (HTTP 401)",
          },
        },
      },
    });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/Bad credentials/);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(1);

    updateFixtures({
      cli: {
        [BACKUP_TOKEN]: { [`issue view -R ${HIDDEN}`]: { out: issueJson() } },
      },
    });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(2);
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(2);
  });

  it("retries on the next read when the token command fails during resolution", async () => {
    resetFixtures({
      ...hiddenReadFixtures(),
      tokens: { [BACKUP_LOGIN]: null },
    });
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/Could not resolve to a Repository/);
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(1);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(0);

    updateFixtures({ tokens: { [BACKUP_LOGIN]: BACKUP_TOKEN } });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(2);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
  });

  it("keeps the binding and skips re-probing when the token call hits a rate-limit 403", async () => {
    resetFixtures(hiddenReadFixtures());
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });

    updateFixtures({
      cli: {
        [BACKUP_TOKEN]: {
          [`issue view -R ${HIDDEN}`]: {
            err: "gh: API rate limit exceeded (HTTP 403)",
          },
        },
      },
    });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/rate limit/);
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/rate limit/);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(1);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
  });

  it("clears bindings on a forced sync and re-probes on the next read", async () => {
    resetFixtures(hiddenReadFixtures());
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);

    await harness.callRpc("refresh");
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(2);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(2);
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(2);
  });

  it("re-resolves a repo whose other account stops seeing it on the next background sync", async () => {
    resetFixtures(hiddenReadFixtures());
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });

    updateFixtures({
      graphql: {
        [ACTIVE]: { [HIDDEN]: { out: graphqlLists(HIDDEN) } },
        [BACKUP_TOKEN]: { [HIDDEN]: { err: GRAPHQL_MISSING(HIDDEN) } },
      },
      cli: {
        [ACTIVE]: { [`issue view -R ${HIDDEN}`]: { out: issueJson() } },
      },
    });
    const { controller, done } = harness.runService("sync");
    await vi.waitFor(
      () => {
        expect(callsFor(ACTIVE, "api graphql")).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    controller.abort();
    await done;

    expect(callsFor(BACKUP_TOKEN, "api graphql")).toHaveLength(1);
    expect(
      harness.logEntries.filter((entry) =>
        entry.message.includes(`sync failed for ${HIDDEN}`),
      ),
    ).toEqual([]);
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(ACTIVE, `issue view 5 -R ${HIDDEN}`)).toHaveLength(2);
  });

  it("disables the fallback while GH_TOKEN is set in the plugin environment", async () => {
    vi.stubEnv("GH_TOKEN", "token-standalone");
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    updateFixtures({
      graphql: {
        "token-standalone": { [HIDDEN]: { err: GRAPHQL_MISSING(HIDDEN) } },
      },
    });

    await expect(harness.callRpc("refresh")).rejects.toThrow(
      /sync failed for all 1 repo/,
    );
    expect(ghCalls().filter((call) => call.includes(HOSTS_CALL))).toEqual([]);
    expect(ghCalls().some((call) => call.includes("--silent"))).toBe(false);
    expect(ghCalls().some((call) => call.startsWith("[token-backup]"))).toBe(
      false,
    );
  });

  it("never uses the fallback for an untracked repo", async () => {
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    updateFixtures({
      cli: { [ACTIVE]: { [`issue view -R other/secret`]: { err: NOT_FOUND } } },
    });

    await expect(
      harness.callRpc("getIssue", { repo: "other/secret", number: 5 }),
    ).rejects.toThrow(/HTTP 404/);
    expect(ghCalls().filter((call) => call.includes(HOSTS_CALL))).toEqual([]);
    expect(
      ghCalls().filter((call) => call.includes("repos/other/secret")),
    ).toEqual([]);
    expect(ghCalls().some((call) => call.startsWith("[token-backup]"))).toBe(
      false,
    );
  });

  it("falls back for getIssue on a hidden repo via the GraphQL not-found wording", async () => {
    resetFixtures(hiddenReadFixtures());
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });

    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({
      issue: {
        repo: HIDDEN,
        number: 5,
        title: "Hidden issue",
        body: "Hidden body.",
      },
    });
    expect(callsFor(BACKUP_TOKEN, `issue view 5 -R ${HIDDEN}`)).toHaveLength(1);
  });

  it("writes no binding when a forced sync resets mid-resolution and re-probes fresh", async () => {
    resetFixtures({
      ...hiddenReadFixtures(),
      repoCheck: {
        [ACTIVE]: { [HIDDEN]: { err: NOT_FOUND } },
        [BACKUP_TOKEN]: { [HIDDEN]: { out: "{}", sleepMs: 300 } },
      },
    });
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    const interrupted = harness.callRpc("getIssue", {
      repo: HIDDEN,
      number: 5,
    });
    await vi.waitFor(
      () => {
        expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
      },
      { timeout: 5_000 },
    );

    updateFixtures({
      repoCheck: { [BACKUP_TOKEN]: { [HIDDEN]: { out: "{}" } } },
    });
    await harness.callRpc("refresh");
    await expect(interrupted).resolves.toMatchObject({
      issue: { title: "Hidden issue" },
    });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(2);
    expect(callsFor(ACTIVE, HIDDEN_REPO_CHECK)).toHaveLength(2);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(2);
  });

  it("re-resolves a bound-none repo once per sync pass with one account-list call per pass", async () => {
    resetFixtures({
      graphql: {
        [ACTIVE]: {
          [HIDDEN]: { err: GRAPHQL_MISSING(HIDDEN) },
          [OPEN]: { out: graphqlLists(OPEN) },
        },
        [BACKUP_TOKEN]: { [HIDDEN]: { err: GRAPHQL_MISSING(HIDDEN) } },
      },
      repoCheck: {
        [ACTIVE]: { [HIDDEN]: { err: NOT_FOUND }, [OPEN]: { out: "{}" } },
        [BACKUP_TOKEN]: { [HIDDEN]: { err: NOT_FOUND } },
      },
    });
    const { harness } = await loadMultiAccount({
      extraRepos: `${HIDDEN},${OPEN}`,
    });
    const syncedCount = () =>
      harness.logEntries.filter(
        (entry) =>
          entry.level === "info" && entry.message.startsWith("synced "),
      ).length;
    const runPass = async (expectedPasses: number) => {
      const { controller, done } = harness.runService("sync");
      await vi.waitFor(() => expect(syncedCount()).toBe(expectedPasses), {
        timeout: 5_000,
      });
      controller.abort();
      await done;
    };

    await runPass(1);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
    expect(
      harness.logEntries.filter((entry) =>
        entry.message.includes(`sync failed for ${HIDDEN}`),
      ),
    ).toHaveLength(1);

    await runPass(2);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(2);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(2);
    expect(
      harness.logEntries.filter((entry) =>
        entry.message.includes(`sync failed for ${HIDDEN}`),
      ),
    ).toHaveLength(2);
  });

  it("binds nothing when the probe exceeds the resolution timeout and retries on the next read", async () => {
    resetFixtures({
      ...hiddenReadFixtures(),
      repoCheck: {
        [ACTIVE]: { [HIDDEN]: { err: NOT_FOUND } },
        [BACKUP_TOKEN]: { [HIDDEN]: { out: "{}", sleepMs: 6_000 } },
      },
    });
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    const first = harness.callRpc("getIssue", { repo: HIDDEN, number: 5 });
    await vi.waitFor(
      () => {
        expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(1);
      },
      { timeout: 5_000 },
    );

    await expect(first).rejects.toThrow(/Could not resolve to a Repository/);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);

    updateFixtures({
      repoCheck: { [BACKUP_TOKEN]: { [HIDDEN]: { out: "{}" } } },
    });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(2);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(1);
  }, 20_000);

  it("binds nothing when the active repo check fails transiently for a repo the other account sees", async () => {
    resetFixtures({
      ...hiddenReadFixtures(),
      repoCheck: {
        [ACTIVE]: { [HIDDEN]: { err: "gh: Internal Server Error (HTTP 500)" } },
        [BACKUP_TOKEN]: { [HIDDEN]: { out: "{}" } },
      },
    });
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/Could not resolve to a Repository/);
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/Could not resolve to a Repository/);
    expect(callsFor(ACTIVE, HIDDEN_REPO_CHECK)).toHaveLength(2);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(0);
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(0);
    expect(identityCalls(BACKUP_TOKEN)).toEqual([]);
  });

  it("probes again on the next read when the only candidate's probe is unauthorized", async () => {
    resetFixtures({
      ...hiddenReadFixtures(),
      repoCheck: {
        [ACTIVE]: { [HIDDEN]: { err: NOT_FOUND } },
        [BACKUP_TOKEN]: { [HIDDEN]: { err: "gh: Bad credentials (HTTP 401)" } },
      },
    });
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/Could not resolve to a Repository/);
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).rejects.toThrow(/Could not resolve to a Repository/);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(1);
    expect(callsFor(BACKUP_TOKEN, HIDDEN_REPO_CHECK)).toHaveLength(2);
    expect(callsFor(ACTIVE, TOKEN_CALL)).toHaveLength(2);
  });

  it("returns no live hit when the resolution itself fails during a 404 lookup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, issues, dispose } = await loadMultiAccount({
      projects: [{ id: "proj-hidden", repos: [HIDDEN] }],
      extraRepos: HIDDEN,
      firstProjectsListDelayMs: 400,
      projectsListRepeatDelayMs: 150,
    });
    await harness.callRpc("status");
    vi.setSystemTime(Date.now() + 61_000);
    updateFixtures({
      rest: {
        [ACTIVE]: {
          [`api --method GET repos/${HIDDEN}/issues/5`]: {
            err: NOT_FOUND,
            sleepMs: 100,
          },
        },
      },
    });
    const search = issues("#5");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await dispose();
    await expect(search).resolves.toEqual([]);
    expect(callsFor(ACTIVE, HOSTS_CALL)).toHaveLength(0);
    expect(identityCalls(BACKUP_TOKEN)).toEqual([]);
    expect(
      callsFor(ACTIVE, `api --method GET repos/${HIDDEN}/issues/5`),
    ).toHaveLength(1);
  });

  it("leaves out the gh hint for a repo read as the other account", async () => {
    resetFixtures(hiddenReadFixtures());
    const { harness } = await loadMultiAccount({ extraRepos: HIDDEN });
    await expect(
      harness.callRpc("getIssue", { repo: HIDDEN, number: 5 }),
    ).resolves.toMatchObject({ issue: { title: "Hidden issue" } });

    const provider = harness.registrations.mentionProviders.find(
      (candidate) => candidate.id === "issue",
    );
    if (provider === undefined) throw new Error("no issue provider");
    const hidden = await provider.resolve(`${HIDDEN}#5`);
    expect(hidden.context).toContain("Hidden issue");
    expect(hidden.context).not.toContain("For full comments/diff run");
    const visible = await provider.resolve(`${OPEN}#5`);
    expect(visible.context).toContain("For full comments/diff run");
  });
});
