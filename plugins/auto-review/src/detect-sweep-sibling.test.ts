import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { turnChangedPaths } from "./detect.js";
import { snapshotTree } from "./detect-tree.js";

/**
 * End to end through `claimedChanges`: the turn-start snapshot is taken first,
 * then a sibling's script writes a file the way a real one does, and the
 * evaluation reads the file's content itself. Reported in thr_8rryqyy9me: a
 * thread that ran an opaque command of its own, long before, was swept and
 * reviewed a file only a sibling's running command had written.
 */

const LEAK = "leak-token-aa31";

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  parentThreadId: null,
  lifecycleOwnerThreadId: null,
  originPluginId: null,
  archivedAt: null,
  deletedAt: null,
  visibility: "visible",
  environmentId: "env",
  providerId: "claude-code",
  status: "active",
  updatedAt: Date.now(),
  ...extra,
});

const command = (text: string, startedAt: number, completedAt: number, over: Record<string, unknown> = {}) => ({
  kind: "work",
  workKind: "command",
  status: "completed",
  approvalStatus: null,
  cwd: "",
  threadId: "t",
  command: text,
  startedAt,
  createdAt: startedAt,
  completedAt,
  ...over,
});

describe("a sweep with a sibling's opaque command running while a file was written", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
    dir = undefined;
  });

  async function evaluate(options: { familyCommandAt?: "far" | "overlapping"; sibling?: boolean } = {}) {
    dir = await mkdtemp(join(tmpdir(), "ar-sweep-"));
    const root = dir;
    const infos: string[] = [];
    const files: Array<{ path: string; status: string; insertions: number | null; deletions: number | null }> = [];
    const workspace = () =>
      ({
        workingTree: { files: [...files] },
        branch: { currentBranch: "b", defaultBranch: "master" },
        checkout: { kind: "branch", headSha: "h0" },
        mergeBase: null,
      }) as never;
    const timelines: Record<string, unknown[]> = {};
    const bb = {
      log: { info: (message: string) => infos.push(message), warn: (message: string) => infos.push(message) },
      sdk: {
        environments: {
          get: async () => ({ path: root }),
          status: async () => ({ outcome: "unavailable" }),
          diffFiles: async () => ({ outcome: "available", files: [] }),
          // The evaluation's own read of the working tree's content.
          diffFile: async ({ path }: { path: string }) => ({ content: await readFile(join(root, path), "utf8") }),
        },
        threads: {
          events: { list: async () => [] },
          timeline: async ({ threadId }: { threadId: string }) => ({
            rows: timelines[threadId] ?? [],
            maxSeq: 0,
            timelinePage: { historySnapshot: "default", olderCursor: null, returnedSegmentCount: 1 },
          }),
        },
      },
    } as never;
    const tree = await snapshotTree(bb, "env", workspace());
    const startedAt = Date.now() - 60_000;
    // The sibling's command runs across the write.
    const before = Date.now();
    await writeFile(join(root, "generated.md"), "# generated\n");
    files.push({ path: "generated.md", status: "??", insertions: null, deletions: null });
    const after = Date.now();
    const sibling = options.sibling ?? true;
    timelines["sib-1"] = sibling ? [command(`node gen.js ${LEAK}`, before - 500, after + 500, { threadId: "sib-1" })] : [];
    // This thread ran its own opaque command long before, which makes its turn a sweep.
    timelines.self = [command("node setup.js", startedAt + 1_000, startedAt + 2_000)];
    if (options.familyCommandAt === "overlapping") {
      timelines.self.push(command("node other.js", before - 200, after + 200));
    }
    const result = await turnChangedPaths(bb, {
      threadId: "self",
      environmentId: "env",
      turnStart: { sinceSeq: 0, startedAt, tree },
      workspace: workspace(),
      threadEntries: [entry("self", { status: "idle" }), entry("sib-1")] as never,
    });
    return { result, infos };
  }

  it("leaves the file to the sibling: stood down with the file unclaimed, and one log line", async () => {
    const { result, infos } = await evaluate();
    expect(result).toMatchObject({ mode: "sweep", paths: [], unclaimed: ["generated.md"] });
    expect(infos).toContain("auto-review: left out of the sweep, changed only while another thread's command ran: generated.md");
    expect(JSON.stringify(infos)).not.toContain(LEAK);
  });

  it("keeps the file when this thread's own command that can write ran then", async () => {
    const { result, infos } = await evaluate({ familyCommandAt: "overlapping" });
    expect(result).toMatchObject({ mode: "sweep", paths: ["generated.md"], unclaimed: [] });
    expect(infos.some((line) => line.includes("left out of the sweep"))).toBe(false);
  });

  it("keeps the file when no sibling's command ran then", async () => {
    const { result } = await evaluate({ sibling: false });
    expect(result).toMatchObject({ mode: "sweep", paths: ["generated.md"], unclaimed: [] });
  });
});
