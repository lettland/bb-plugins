import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  BASELINE_TTL_MS,
  CODE_DELTA_BUDGET,
  clearPlanBaseline,
  deleteBaselines,
  MAX_BASELINE_FILE_BYTES,
  MAX_CODE_BASELINE_FILES,
  PLAN_DELTA_BUDGET,
  planScope,
  prepareCodeBaseline,
  recordCodeReport,
  settleCodeBaseline,
  settlePlanBaseline,
  stagePlanPending,
  unifiedDelta,
} from "./baseline-store.js";
import type { AvailableWorkspace } from "./detect-workspace.js";

const THREAD = "thread-1";
const PLAN = "/p/plan.md";
const NOW = 1_800_000_000_000;

interface Fake {
  bb: BbPluginApi;
  kv: Map<string, unknown>;
  warnings: string[];
  /** What `diffFile` serves per path; a missing path throws. */
  files: Record<string, string>;
}

function fake(files: Record<string, string> = {}): Fake {
  const kv = new Map<string, unknown>();
  const warnings: string[] = [];
  const served = files;
  const bb = {
    storage: {
      kv: {
        get: async (key: string) => kv.get(key) ?? null,
        set: async (key: string, value: unknown) => {
          kv.set(key, structuredClone(value));
        },
        delete: async (key: string) => {
          kv.delete(key);
        },
        list: async (prefix: string) => [...kv.keys()].filter((key) => key.startsWith(prefix)),
      },
    },
    log: { warn: (message: string) => warnings.push(message), info: () => undefined },
    sdk: {
      environments: {
        diffFile: async ({ path }: { path: string }) => {
          const content = served[path];
          if (content === undefined) {
            throw new Error(`no content for ${path}`);
          }
          return { path, content, contentEncoding: "utf8", sizeBytes: content.length };
        },
      },
    },
  } as unknown as BbPluginApi;
  return { bb, kv, warnings, files: served };
}

function workspace(paths: Record<string, string>, headSha = "head-1"): AvailableWorkspace {
  return {
    checkout: { kind: "branch", branchName: "b", headSha },
    workingTree: { files: Object.entries(paths).map(([path, status]) => ({ path, status })) },
  } as unknown as AvailableWorkspace;
}

const openBlocker = {
  chains: {
    k: {
      key: "k", title: "t", file: "src/a.ts", severity: "blocker", status: "open", firstSeenAt: 1, lastSeenAt: 1,
      raisedCount: 1, dismissCount: 0, reRaised: false, lastReviewId: 1,
    },
  },
  incidents: [],
};

const lines = (count: number, prefix = "line"): string =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join("\n") + "\n";

describe("unifiedDelta", () => {
  it("is empty for equal text and a unified diff with three lines of context otherwise", () => {
    expect(unifiedDelta("a\n", "a\n", "x")).toBe("");
    const diff = unifiedDelta(lines(20), lines(20).replace("line 10", "LINE 10"), "src/x.ts");
    expect(diff).toContain("--- a/src/x.ts");
    expect(diff).toContain("+++ b/src/x.ts");
    expect(diff).toContain("-line 10\n+LINE 10");
    expect(diff).toContain(" line 7\n");
    expect(diff).not.toContain(" line 6\n");
    expect(diff).not.toContain("Index:");
  });
});

describe("plan baselines", () => {
  const cycle = async (f: Fake, content: string, completed = true): Promise<void> => {
    await stagePlanPending(f.bb, THREAD, PLAN, content, NOW);
    await settlePlanBaseline(f.bb, THREAD, PLAN, completed);
  };

  it("reviews in full until a completed review promoted a copy, then reviews only the delta", async () => {
    const f = fake();
    expect(await planScope(f.bb, THREAD, PLAN, "v1\n", NOW)).toEqual({ kind: "full" });
    await cycle(f, "step a\nstep b\n");
    const scope = await planScope(f.bb, THREAD, PLAN, "step a\nstep B\n", NOW);
    expect(scope.kind).toBe("delta");
    expect(scope.kind === "delta" && scope.diff).toContain("-step b\n+step B");
  });

  it("says the plan is unchanged when its text equals the copy", async () => {
    const f = fake();
    await cycle(f, "same\n");
    expect(await planScope(f.bb, THREAD, PLAN, "same\n", NOW)).toEqual({ kind: "unchanged" });
  });

  it("keeps the pending text apart from the copy until the review ends", async () => {
    const f = fake();
    await cycle(f, "v1\n");
    await stagePlanPending(f.bb, THREAD, PLAN, "v2\n", NOW);
    const scope = await planScope(f.bb, THREAD, PLAN, "v3\n", NOW);
    expect(scope.kind === "delta" && scope.diff).toContain("-v1\n+v3");
  });

  it("drops the pending text and keeps the older copy when the review did not complete", async () => {
    const f = fake();
    await cycle(f, "v1\n");
    await cycle(f, "v2\n", false);
    const scope = await planScope(f.bb, THREAD, PLAN, "v3\n", NOW);
    expect(scope.kind === "delta" && scope.diff).toContain("-v1\n+v3");
  });

  it("does not promote while a Blocker is open in the thread's findings", async () => {
    const f = fake();
    f.kv.set(`findings:${THREAD}`, openBlocker);
    await cycle(f, "v1\n");
    expect(await planScope(f.bb, THREAD, PLAN, "v1\n", NOW)).toEqual({ kind: "full" });
  });

  it("reviews in full when the delta is over the budget, or too large to diff", async () => {
    const f = fake();
    const padded = (prefix: string) => lines(1_800, `${prefix}-padding-padding`);
    await cycle(f, padded("old"));
    expect(unifiedDelta(padded("old"), padded("new"), "plan")?.length).toBeGreaterThan(PLAN_DELTA_BUDGET);
    expect(await planScope(f.bb, THREAD, PLAN, padded("new"), NOW)).toEqual({ kind: "full" });
    expect(unifiedDelta(lines(4_000, "old"), lines(4_000, "new"), "plan")).toBeUndefined();
    // Diffing thousands of lines takes seconds under coverage, past the 5 s default.
  }, 30_000);

  it("keeps no baseline for a plan that cannot be read or is too large", async () => {
    const f = fake();
    await cycle(f, "v1\n");
    expect(await planScope(f.bb, THREAD, PLAN, null, NOW)).toEqual({ kind: "full" });
    expect(await planScope(f.bb, THREAD, null, "v1\n", NOW)).toEqual({ kind: "full" });
    const huge = "x".repeat(MAX_BASELINE_FILE_BYTES + 1);
    expect(await planScope(f.bb, THREAD, PLAN, huge, NOW)).toEqual({ kind: "full" });
    await stagePlanPending(f.bb, THREAD, PLAN, huge, NOW);
    expect(await planScope(f.bb, THREAD, PLAN, "v1\n", NOW)).toEqual({ kind: "full" });
  });

  it("drops a copy older than the TTL when it is touched", async () => {
    const f = fake();
    await cycle(f, "v1\n");
    const later = NOW + BASELINE_TTL_MS + 1;
    expect(await planScope(f.bb, THREAD, PLAN, "v1\n", later)).toEqual({ kind: "full" });
    expect(await f.bb.storage.kv.list("baseline:plan:")).toEqual([]);
  });

  it("is cleared by an approval or a redo, and kept apart per plan path", async () => {
    const f = fake();
    await cycle(f, "v1\n");
    await stagePlanPending(f.bb, THREAD, "/p/other.md", "o\n", NOW);
    await settlePlanBaseline(f.bb, THREAD, "/p/other.md", true);
    await clearPlanBaseline(f.bb, THREAD, PLAN);
    expect(await planScope(f.bb, THREAD, PLAN, "v1\n", NOW)).toEqual({ kind: "full" });
    expect(await planScope(f.bb, THREAD, "/p/other.md", "o\n", NOW)).toEqual({ kind: "unchanged" });
  });

  it("falls back to a full review when the store cannot be read", async () => {
    const f = fake();
    f.bb.storage.kv.get = async () => {
      throw new Error("kv down");
    };
    expect(await planScope(f.bb, THREAD, PLAN, "v1\n", NOW)).toEqual({ kind: "full" });
    expect(f.warnings.some((message) => message.includes("kv down"))).toBe(true);
  });
});

describe("code baselines", () => {
  const prepare = (f: Fake, ws: AvailableWorkspace | null, paths: string[], now = NOW) =>
    prepareCodeBaseline(f.bb, { threadId: THREAD, environmentId: "env-1", paths, workspace: ws, now });
  const clean = { findings: [] as { file: string; status: string; security?: boolean }[] };
  const stored = (f: Fake) => f.kv.get(`baseline:code:${THREAD}`) as {
    copies: Record<string, { content: string; headSha: string }>;
    pending?: { headSha: string; files: Record<string, string | null> };
    clean?: boolean;
  };

  /** One clean review of `files` at `head`: prepare, report, settle. */
  async function review(f: Fake, files: Record<string, string>, head = "head-1") {
    f.files = Object.assign(f.files, files);
    const scope = await prepare(f, workspace(Object.fromEntries(Object.keys(files).map((p) => [p, "M"])), head), Object.keys(files));
    await recordCodeReport(f.bb, THREAD, clean, false);
    await settleCodeBaseline(f.bb, THREAD, NOW);
    return scope;
  }

  it("reviews in full the first time and stages what the files read as pending", async () => {
    const f = fake({ "src/a.ts": "a1\n" });
    const scope = await prepare(f, workspace({ "src/a.ts": "M" }), ["src/a.ts"]);
    expect(scope).toEqual([]);
    expect(stored(f)).toMatchObject({ copies: {}, pending: { headSha: "head-1", files: { "src/a.ts": "a1\n" } } });
  });

  it("promotes the pending files when the review ended clean and embeds only their delta next time", async () => {
    const f = fake();
    expect(await review(f, { "src/a.ts": "a1\na2\n", "src/b.ts": "b1\n" })).toEqual([]);
    expect(stored(f)).toMatchObject({ copies: { "src/a.ts": { content: "a1\na2\n", headSha: "head-1" } } });
    expect(stored(f).pending).toBeUndefined();

    f.files["src/a.ts"] = "a1\nA2\n";
    const scope = await prepare(f, workspace({ "src/a.ts": "M", "src/b.ts": "M" }), ["src/a.ts", "src/b.ts"]);
    expect(scope.map(({ path, kind }) => [path, kind])).toEqual([["src/a.ts", "delta"], ["src/b.ts", "unchanged"]]);
    expect(scope[0]?.diff).toContain("-a2\n+A2");
  });

  it("drops the pending files when the review reported a Blocker, or never reported", async () => {
    const f = fake();
    await review(f, { "src/a.ts": "a1\n" });
    f.files["src/a.ts"] = "a2\n";
    await prepare(f, workspace({ "src/a.ts": "M" }), ["src/a.ts"]);
    await recordCodeReport(f.bb, THREAD, clean, true);
    await settleCodeBaseline(f.bb, THREAD, NOW);
    expect(stored(f)).toEqual({ copies: { "src/a.ts": expect.objectContaining({ content: "a1\n" }) } });

    await prepare(f, workspace({ "src/a.ts": "M" }), ["src/a.ts"]);
    await settleCodeBaseline(f.bb, THREAD, NOW);
    expect(stored(f).copies["src/a.ts"]?.content).toBe("a1\n");
    expect(stored(f).pending).toBeUndefined();
  });

  it("does not count an open security finding as clean, and drops the flagged file's copy and pending", async () => {
    const f = fake();
    await review(f, { "src/a.ts": "a1\n", "src/b.ts": "b1\n" });
    f.files["src/a.ts"] = "a2\n";
    f.files["src/b.ts"] = "b2\n";
    await prepare(f, workspace({ "src/a.ts": "M", "src/b.ts": "M" }), ["src/a.ts", "src/b.ts"]);
    await recordCodeReport(f.bb, THREAD, { findings: [{ file: "src/a.ts", status: "open", security: true }] }, false);
    expect(stored(f).copies["src/a.ts"]).toBeUndefined();
    expect(stored(f).pending?.files["src/a.ts"]).toBeUndefined();
    await settleCodeBaseline(f.bb, THREAD, NOW);
    expect(stored(f).copies["src/b.ts"]?.content).toBe("b1\n");
    expect(stored(f).copies["src/a.ts"]).toBeUndefined();
  });

  it("drops a flagged file's copy even when the finding was fixed, while the review itself ends clean", async () => {
    const f = fake();
    await review(f, { "src/a.ts": "a1\n", "src/b.ts": "b1\n" });
    f.files["src/a.ts"] = "a2\n";
    f.files["src/b.ts"] = "b2\n";
    await prepare(f, workspace({ "src/a.ts": "M", "src/b.ts": "M" }), ["src/a.ts", "src/b.ts"]);
    await recordCodeReport(f.bb, THREAD, { findings: [{ file: "src/a.ts", status: "fixed", security: true }] }, false);
    await settleCodeBaseline(f.bb, THREAD, NOW);
    expect(Object.keys(stored(f).copies)).toEqual(["src/b.ts"]);
    expect(stored(f).copies["src/b.ts"]?.content).toBe("b2\n");
    // The flagged file gets a fresh full review, never a delta.
    const scope = await prepare(f, workspace({ "src/a.ts": "M", "src/b.ts": "M" }), ["src/a.ts", "src/b.ts"]);
    expect(scope.map(({ path }) => path)).toEqual(["src/b.ts"]);
  });

  it("ignores a copy once HEAD moved", async () => {
    const f = fake();
    await review(f, { "src/a.ts": "a1\n" }, "head-1");
    f.files["src/a.ts"] = "a2\n";
    const scope = await prepare(f, workspace({ "src/a.ts": "M" }, "head-2"), ["src/a.ts"]);
    expect(scope).toEqual([]);
    expect(stored(f).pending?.headSha).toBe("head-2");
  });

  it("has no baseline without a HEAD to compare, and stages nothing", async () => {
    const f = fake({ "src/a.ts": "a1\n" });
    expect(await prepare(f, null, ["src/a.ts"])).toEqual([]);
    expect(stored(f).pending).toBeUndefined();
    const detached = { checkout: { kind: "unborn" }, workingTree: { files: [] } } as unknown as AvailableWorkspace;
    expect(await prepare(f, detached, ["src/a.ts"])).toEqual([]);
  });

  it("makes a deleted file's delta the removal, and drops its copy once the review ends clean", async () => {
    const f = fake();
    await review(f, { "src/a.ts": "a1\na2\n" });
    const scope = await prepare(f, workspace({ "src/a.ts": "D" }), ["src/a.ts"]);
    expect(scope).toHaveLength(1);
    expect(scope[0]).toMatchObject({ path: "src/a.ts", kind: "removed" });
    expect(scope[0]?.diff).toContain("-a1\n-a2");
    expect(stored(f).pending?.files["src/a.ts"]).toBeNull();
    await recordCodeReport(f.bb, THREAD, clean, false);
    await settleCodeBaseline(f.bb, THREAD, NOW);
    expect(stored(f).copies).toEqual({});
  });

  it("gives a file a full review when its delta would overrun the total budget", async () => {
    const f = fake();
    const big = (prefix: string) => lines(1_500, `${prefix}-padding-padding`);
    await review(f, { "src/a.ts": big("a"), "src/b.ts": big("b"), "src/c.ts": "c\n" });
    f.files["src/a.ts"] = big("A");
    f.files["src/b.ts"] = big("B");
    f.files["src/c.ts"] = "C\n";
    const each = unifiedDelta(big("a"), big("A"), "src/a.ts")?.length ?? 0;
    expect(each).toBeLessThan(CODE_DELTA_BUDGET);
    expect(each * 2).toBeGreaterThan(CODE_DELTA_BUDGET);
    const scope = await prepare(
      f,
      workspace({ "src/a.ts": "M", "src/b.ts": "M", "src/c.ts": "M" }),
      ["src/a.ts", "src/b.ts", "src/c.ts"],
    );
    expect(scope.map(({ path }) => path)).toEqual(["src/a.ts", "src/c.ts"]);
  });

  it("gives no baseline to a file it cannot read, is too large, or is not in the working tree", async () => {
    const f = fake();
    await review(f, { "src/a.ts": "a1\n", "src/b.ts": "b1\n", "src/c.ts": "c1\n" });
    f.files["src/b.ts"] = "x".repeat(MAX_BASELINE_FILE_BYTES + 1);
    delete f.files["src/a.ts"];
    f.files["src/c.ts"] = "c2\n";
    const scope = await prepare(
      f,
      workspace({ "src/a.ts": "M", "src/b.ts": "M" }),
      ["src/a.ts", "src/b.ts", "src/c.ts"],
    );
    expect(scope).toEqual([]);
    expect(stored(f).pending?.files).toEqual({});
    expect(stored(f).copies).toEqual({});
  });

  it("keeps at most the file limit in a review's pending set", async () => {
    const paths = Array.from({ length: MAX_CODE_BASELINE_FILES + 10 }, (_, i) => `f${i}.ts`);
    const f = fake(Object.fromEntries(paths.map((path) => [path, "x\n"])));
    await prepare(f, workspace(Object.fromEntries(paths.map((path) => [path, "M"]))), paths);
    expect(Object.keys(stored(f).pending?.files ?? {})).toHaveLength(MAX_CODE_BASELINE_FILES);
  });

  it("drops copies older than the TTL when touched", async () => {
    const f = fake();
    await review(f, { "src/a.ts": "a1\n" });
    const later = NOW + BASELINE_TTL_MS + 1;
    f.files["src/a.ts"] = "a2\n";
    expect(await prepare(f, workspace({ "src/a.ts": "M" }), ["src/a.ts"], later)).toEqual([]);
    expect(stored(f).copies).toEqual({});
  });

  it("settles nothing when no review staged anything, and never throws on a store failure", async () => {
    const f = fake();
    await settleCodeBaseline(f.bb, THREAD, NOW);
    await recordCodeReport(f.bb, THREAD, clean, false);
    expect(f.kv.size).toBe(0);
    f.bb.storage.kv.set = async () => {
      throw new Error("kv full");
    };
    f.files["src/a.ts"] = "a\n";
    await expect(prepare(f, workspace({ "src/a.ts": "M" }), ["src/a.ts"])).resolves.toEqual([]);
    expect(f.warnings.some((message) => message.includes("kv full"))).toBe(true);
  });

  it("is removed with the thread's other baselines by deleteBaselines", async () => {
    const f = fake();
    await review(f, { "src/a.ts": "a1\n" });
    await stagePlanPending(f.bb, THREAD, PLAN, "v1\n", NOW);
    await stagePlanPending(f.bb, "thread-2", PLAN, "v1\n", NOW);
    await deleteBaselines(f.bb, THREAD);
    expect([...f.kv.keys()].filter((key) => key.startsWith("baseline:"))).toEqual([
      expect.stringContaining("baseline:plan:thread-2:"),
    ]);
  });
});
