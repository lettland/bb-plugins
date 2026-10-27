import { describe, expect, it } from "vitest";
import { turnChangedPaths } from "./detect.js";
import { commitScanHead } from "./dispatch.js";
import type { ThreadState } from "./state.js";

const STARTED_AT = 10_000;
const PARKED_AT = 30_000;

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  parentThreadId: null,
  lifecycleOwnerThreadId: null,
  deletedAt: null,
  status: "idle",
  updatedAt: 50_000,
  ...extra,
});
const self = entry("self");

const base = { kind: "work", status: "completed", startedAt: 12_000, createdAt: 12_000, completedAt: 13_000 };
const command = (text: string, over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "command",
  approvalStatus: null,
  command: text,
  cwd: "/w",
  ...over,
});
/** Something whose writes cannot be listed, so the turn is attributed by sweep. */
const opaque = command("/opt/bin/builder --all");

interface Commit {
  sha: string;
  paths: string[] | null;
  authoredAt?: number;
}

interface Options {
  /** The turn-start and park fingerprints, by path. */
  turnFiles?: Record<string, string>;
  parkFiles?: Record<string, string>;
  /** The commits made since the turn started, oldest first, with the paths each touched. */
  chain?: Commit[];
  /** How many of `chain` existed when the turn was parked; the park head is the last of them, or `h0`. */
  parkedAfter?: number;
  /** Replaces the park head. */
  parkHead?: string | null;
  /** Replaces the status answer for the park head. */
  ancestry?: (args: Record<string, unknown>) => unknown;
  /** The checkout is the mainline: no merge base, commits found by asking from the turn-start head. */
  mainline?: boolean;
  /** Uncommitted paths now, with their added lines. */
  uncommitted?: Array<string | [string, number]>;
  timelines?: Record<string, unknown[] | Error>;
  entries?: unknown[];
  /** Replaces the park; null leaves the turn without one. */
  park?: Record<string, unknown> | null;
  /** Replaces the time the turn started; null leaves it unknown. */
  startedAt?: number | null;
  /** The thread's own timeline can be read this many times; the next read fails. */
  selfReads?: number;
  /** Rows the thread's timeline gains after this many reads of it. */
  lateRows?: { threadId?: string; reads: number; rows: unknown[] };
  /** Untracked paths now. */
  untracked?: string[];
  /** The `aheadCount` every status answer reports, instead of the number of commits listed. */
  aheadCount?: number;
  /** Replace what the park snapshot holds of the commits made before it. */
  parkCommits?: { commits?: string[]; recentCommits?: Array<{ sha: string; authorName: string; authoredAt: number; subject: string }> };
  /** Replace the turn-start snapshot's commit lists. */
  turnCommits?: { commits?: string[]; recentCommits?: Array<{ sha: string; authorName: string; authoredAt: number; subject: string }> };
}

const recent = (sha: string) => ({ sha, authorName: "a", authoredAt: 1_000, subject: sha });

async function released(options: Options = {}) {
  const infos: string[] = [];
  const statusCalls: Array<Record<string, unknown>> = [];
  const chain = options.chain ?? [];
  let selfReads = 0;
  const reads = new Map<string, number>();
  const head = chain.at(-1)?.sha ?? "h0";
  const parkHead = "parkHead" in options ? options.parkHead : (chain[(options.parkedAfter ?? 0) - 1]?.sha ?? "h0");
  const live = {
    workingTree: {
      files: [
        ...(options.uncommitted ?? []).map((entry) => {
          const [path, insertions] = typeof entry === "string" ? [entry, 1] : entry;
          return { path, status: "M", insertions, deletions: 0 };
        }),
        ...(options.untracked ?? []).map((path) => ({ path, status: "??", insertions: null, deletions: null })),
      ],
    },
    branch: { currentBranch: "b", defaultBranch: "master" },
    checkout: { kind: "branch", branchName: "b", headSha: head },
    mergeBase:
      options.mainline === true
        ? null
        : { files: [], aheadCount: options.aheadCount ?? chain.length, commits: chain.map(({ sha, authoredAt }) => ({ sha, authoredAt: authoredAt ?? 25_000 })) },
  };
  const bb = {
    log: { info: (message: string) => infos.push(message), warn: (message: string) => infos.push(message) },
    sdk: {
      environments: {
        status: async (args: Record<string, unknown>) => {
          statusCalls.push(args);
          const ref = args.mergeBaseBranch;
          if (ref === parkHead && options.ancestry !== undefined) {
            return options.ancestry(args);
          }
          const at = ref === "h0" ? -1 : chain.findIndex(({ sha }) => sha === ref);
          if (typeof ref !== "string" || (ref !== "h0" && at === -1)) {
            return { outcome: "unavailable" };
          }
          const ahead = chain.slice(at + 1);
          return {
            outcome: "available",
            workspace: {
              ...live,
              mergeBase: {
                files: [],
                mergeBaseBranch: ref,
                baseRef: ref,
                aheadCount: options.aheadCount ?? ahead.length,
                commits: ahead.map(({ sha, authoredAt }) => ({ sha, authoredAt: authoredAt ?? 25_000 })),
              },
            },
          };
        },
        diffFile: async () => ({ content: "x" }),
        diffFiles: async ({ sha }: { sha: string }) => {
          const paths = chain.find((commit) => commit.sha === sha)?.paths;
          if (paths === null || paths === undefined) {
            throw new Error("unreadable");
          }
          return { outcome: "available", files: paths.map((path) => ({ path, previousPath: null })) };
        },
      },
      threads: {
        timeline: async ({ threadId }: { threadId: string }) => {
          const rows = options.timelines?.[threadId] ?? [];
          if (threadId === "self" && selfReads++ >= (options.selfReads ?? Infinity)) {
            throw new Error("timeline unavailable");
          }
          if (rows instanceof Error) {
            throw rows;
          }
          reads.set(threadId, (reads.get(threadId) ?? 0) + 1);
          if (options.lateRows !== undefined && threadId === (options.lateRows.threadId ?? "self") && (reads.get(threadId) ?? 0) > options.lateRows.reads) {
            return { rows: [...rows, ...options.lateRows.rows], maxSeq: 0, timelinePage: { historySnapshot: "default", olderCursor: null, returnedSegmentCount: 0 } };
          }
          return { rows, maxSeq: 0, timelinePage: { historySnapshot: "default", olderCursor: null, returnedSegmentCount: 0 } };
        },
      },
    },
  } as never;
  const turnTree = { headSha: "h0", files: options.turnFiles ?? {}, commits: [], ...options.turnCommits };
  // What the snapshots hold of the commits made before the park: on a branch the commits ahead, on the mainline the recent ones.
  const before = chain.slice(0, options.parkedAfter ?? 0).map(({ sha }) => sha);
  const heldAtPark = options.mainline === true ? { commits: [], recentCommits: [...before.map(recent), recent("h0")] } : { commits: before };
  const park =
    options.park === null
      ? undefined
      : { startedAt: PARKED_AT, tree: { headSha: parkHead, files: options.parkFiles ?? {}, ...heldAtPark, ...options.parkCommits }, ...options.park };
  const result = await turnChangedPaths(bb, {
    threadId: "self",
    environmentId: "env",
    turnStart: { sinceSeq: 5, ...(options.startedAt === null ? {} : { startedAt: options.startedAt ?? STARTED_AT }), tree: turnTree },
    workspace: live as never,
    threadEntries: (options.entries ?? [self]) as never,
    ...(park === undefined ? {} : { park }),
  } as never);
  return { result, infos, statusCalls, state: { turnStart: { sinceSeq: 5, startedAt: STARTED_AT, tree: turnTree } } as unknown as ThreadState };
}

/** What a release without the park filter would have reported: nothing is parked. */
const noneParked = { parkedCommits: [], parkedPaths: [] };

const rowAt = (kind: Record<string, unknown>, startedAt: number, completedAt = startedAt + 500) => ({
  ...base,
  ...kind,
  startedAt,
  createdAt: startedAt,
  completedAt,
});
const edit = (path: string, startedAt: number) =>
  rowAt({ workKind: "file-change", approvalStatus: null, sourceSeqStart: 10, change: { path, movePath: null } }, startedAt);

describe("a turn released from a park", () => {
  describe("leaves out what changed while it waited", () => {
    it("an uncommitted path that was dirty only after the park", async () => {
      const { result, statusCalls, infos } = await released({
        timelines: { self: [opaque] },
        parkFiles: { "lib/before.ts": "M:1:0|abc" },
        uncommitted: ["lib/before.ts", "lib/after.ts"],
      });
      expect(result).toMatchObject({
        mode: "sweep",
        paths: ["lib/before.ts"],
        parkedPaths: ["lib/after.ts"],
        parkedCommits: [],
      });
      // The head did not move, so the park head is trivially an ancestor.
      expect(statusCalls).toEqual([]);
      expect(infos.filter((line) => line.includes("while it was parked"))).toEqual([
        "auto-review: left out of the turn what changed while it was parked since 1970-01-01T00:00:30.000Z: commits []; paths [lib/after.ts]",
      ]);
    });

    it("a commit fast-forwarded in after the park that touched only untouched paths, still scanned", async () => {
      const { result, state } = await released({
        timelines: { self: [opaque] },
        chain: [{ sha: "c1", paths: ["lib/new.ts"], authoredAt: 35_000 }],
      });
      expect(result).toMatchObject({ paths: [], commits: [], parkedCommits: ["c1"], parkedPaths: ["lib/new.ts"] });
      expect(commitScanHead(result, state)).toBe("h0");
    });

    it("commits authored before the park that a fast-forward merge brought in while it waited", async () => {
      const { result } = await released({
        timelines: { self: [opaque] },
        chain: [
          { sha: "m1", paths: ["lib/m1.ts"], authoredAt: 14_000 },
          { sha: "m2", paths: ["lib/m2.ts"], authoredAt: 15_000 },
        ],
      });
      expect(result).toMatchObject({ commits: [], parkedCommits: ["m1", "m2"], parkedPaths: ["lib/m1.ts", "lib/m2.ts"] });
    });
  });

  describe("names what it left out", () => {
    it("in one log line with the park time, the shas and the paths", async () => {
      const { infos } = await released({
        timelines: { self: [opaque] },
        uncommitted: ["lib/after.ts"],
        chain: [{ sha: "c1", paths: ["lib/new.ts"], authoredAt: 35_000 }],
      });
      expect(infos.filter((line) => line.includes("while it was parked"))).toEqual([
        "auto-review: left out of the turn what changed while it was parked since 1970-01-01T00:00:30.000Z: commits [c1]; paths [lib/after.ts, lib/new.ts]",
      ]);
    });

    it("but never untracked harness output, which neither snapshot holds", async () => {
      const { result } = await released({
        timelines: { self: [opaque] },
        uncommitted: ["lib/after.ts"],
        untracked: [".claude/settings.local.json", ".bb/log.txt"],
      });
      expect(result).toMatchObject({ paths: [], parkedPaths: ["lib/after.ts"] });
    });

    it("a sibling's git commit made after the park as parked, not as the sibling's", async () => {
      const sibling = entry("sibling", { status: "active" });
      const git = rowAt({ workKind: "command", approvalStatus: null, command: "git commit -q -m x", cwd: "/w" }, 35_000);
      const { result } = await released({
        entries: [self, sibling],
        timelines: { self: [opaque], sibling: [git] },
        chain: [{ sha: "c1", paths: ["lib/theirs.ts"], authoredAt: 35_200 }],
      });
      expect(result).toMatchObject({ commits: [], foreignCommits: [], parkedCommits: ["c1"] });
    });
  });

  describe("keeps with the turn", () => {
    it("a path the turn changed before the park and someone changed again", async () => {
      const { result } = await released({
        timelines: { self: [opaque] },
        parkFiles: { "lib/x.ts": "M:1:0|abc" },
        uncommitted: ["lib/x.ts"],
      });
      expect(result).toMatchObject({ paths: ["lib/x.ts"], ...noneParked });
    });

    it("a path that was dirty at turn start and at the park, once the turn touched it", async () => {
      const { result } = await released({
        timelines: { self: [opaque] },
        turnFiles: { "lib/x.ts": "M:1:0|abc" },
        parkFiles: { "lib/x.ts": "M:2:0|def" },
        uncommitted: [["lib/x.ts", 3]],
      });
      expect(result).toMatchObject({ paths: ["lib/x.ts"], ...noneParked });
    });

    it("the turn's dirty file when the user committed it while the turn waited", async () => {
      const { result } = await released({
        timelines: { self: [opaque] },
        parkFiles: { "lib/mine.ts": "M:1:0|abc" },
        chain: [{ sha: "c1", paths: ["lib/mine.ts"], authoredAt: 35_000 }],
      });
      expect(result).toMatchObject({ commits: ["c1"], paths: ["lib/mine.ts"], ...noneParked });
    });

    it.each([
      ["a mainline checkout", true],
      ["a branch checkout", false],
    ])("a commit after the park that touched a path of the turn's own earlier commit, on %s", async (_name, mainline) => {
      const { result } = await released({
        mainline,
        timelines: { self: [opaque] },
        parkedAfter: 1,
        chain: [
          { sha: "c1", paths: ["lib/mine.ts"], authoredAt: 20_000 },
          { sha: "c2", paths: ["lib/mine.ts", "lib/other.ts"], authoredAt: 35_000 },
        ],
      });
      expect(result).toMatchObject({ commits: ["c1", "c2"], ...noneParked });
      expect([...result.paths].sort()).toEqual(["lib/mine.ts", "lib/other.ts"]);
    });

    it.each([
      ["mainline", true, { recentCommits: [recent("h0")] }],
      ["branch", false, { commits: ["h0"] }],
    ])("a path of a commit made before the park that the turn's own list dropped, on a %s checkout", async (_name, mainline, turnCommits) => {
      // Its author date is older than the turn, as an amend's is, so the turn's list does not hold it.
      const { result, infos } = await released({
        mainline,
        turnCommits,
        parkCommits: mainline ? undefined : { commits: ["h0", "c1"] },
        timelines: { self: [opaque] },
        parkedAfter: 1,
        chain: [{ sha: "c1", paths: ["lib/c1file.ts"], authoredAt: 5_000 }],
        uncommitted: ["lib/c1file.ts", "lib/after.ts"],
      });
      expect(result.commits).toEqual([]);
      expect(result).toMatchObject({ parkedPaths: ["lib/after.ts"], parkedCommits: [] });
      expect(result.paths).toEqual(["lib/c1file.ts"]);
      expect(infos.filter((line) => line.includes("not leaving out"))).toEqual([]);
    });

    it("a file edited without a hash before the park, when it changes again after", async () => {
      const { result } = await released({
        timelines: { self: [opaque] },
        turnFiles: { "lib/u.ts": "M:1:0|" },
        parkFiles: { "lib/u.ts": "M:1:0|" },
        uncommitted: [["lib/u.ts", 5]],
      });
      expect(result).toMatchObject({ paths: ["lib/u.ts"], ...noneParked });
    });

    it("an untouched path that a kept commit also touched, though it is dirty too", async () => {
      const { result } = await released({
        timelines: { self: [opaque] },
        parkFiles: { "lib/mine.ts": "M:1:0|abc" },
        uncommitted: ["lib/mine.ts", "lib/other.ts"],
        chain: [{ sha: "c1", paths: ["lib/mine.ts", "lib/other.ts"], authoredAt: 35_000 }],
      });
      expect(result).toMatchObject({ commits: ["c1"], ...noneParked });
      expect([...result.paths].sort()).toEqual(["lib/mine.ts", "lib/other.ts"]);
    });

    it.each([
      ["touched before the park", ["lib/mine.ts"], true],
      ["not touched before the park", ["lib/theirs.ts"], false],
    ])("a merge commit after the park: ancestry passes and its paths decide (%s)", async (_name, paths, kept) => {
      const { result } = await released({
        timelines: { self: [opaque] },
        parkFiles: { "lib/mine.ts": "M:1:0|abc" },
        uncommitted: ["lib/mine.ts"],
        chain: [{ sha: "merge1", paths, authoredAt: 35_000 }],
      });
      expect(result.commits).toEqual(kept ? ["merge1"] : []);
      expect(result.parkedCommits).toEqual(kept ? [] : ["merge1"]);
    });
  });

  describe("leaves everything with the turn", () => {
    const afterPark = { uncommitted: ["lib/after.ts"], chain: [{ sha: "c1", paths: ["lib/new.ts"], authoredAt: 35_000 }] };
    const sweepOnly = { timelines: { self: [opaque] } };

    async function unfiltered(options: Options, reason?: string) {
      const { result, infos } = await released({ ...sweepOnly, ...options });
      expect(result).toMatchObject(noneParked);
      if (reason !== undefined) {
        expect(infos).toContain(`auto-review: not leaving out what changed while the turn was parked: ${reason}`);
      }
      return result;
    }

    const status = (over: Record<string, unknown>, head = "c1") => () => ({
      outcome: "available",
      workspace: {
        workingTree: { files: [] },
        branch: { currentBranch: "b", defaultBranch: "master" },
        checkout: { kind: "branch", branchName: "b", headSha: head },
        mergeBase: { files: [], mergeBaseBranch: "p1", baseRef: "p1", aheadCount: 1, commits: [{ sha: "c1" }], ...over },
      },
    });
    // The park head is `p1`; the checkout is at `c1`, which has to descend from it.
    const rewritten = { parkHead: "p1", chain: [{ sha: "c1", paths: ["lib/new.ts"], authoredAt: 35_000 }], uncommitted: ["lib/after.ts"] };

    const notDescended = "the checkout does not descend from the park head";
    it.each([
      ["a content-changing amend of the turn's own commit", { ...rewritten, ancestry: status({ baseRef: "h0" }) }, notDescended],
      ["a rebase with conflict resolution", { ...rewritten, ancestry: status({ baseRef: "h0", aheadCount: 2, commits: [{ sha: "c1" }, { sha: "c0" }] }) }, notDescended],
      ["a status answer for another ref", { ...rewritten, ancestry: status({ mergeBaseBranch: "other" }) }, notDescended],
      ["an incomplete list of commits after the park", { ...rewritten, ancestry: status({ aheadCount: 3 }) }, "the list of commits after the park is incomplete"],
      ["a status that is not available", { ...rewritten, ancestry: () => ({ outcome: "unavailable" }) }, "no answer to compare the park head against"],
      ["a checkout that moved while the head was checked", { ...rewritten, ancestry: status({}, "elsewhere") }, "the checkout moved while the park head was checked"],
      ["a park snapshot with no head", { ...afterPark, parkHead: null }, "the park snapshot or the checkout has no head commit"],
    ] as Array<[string, Options, string]>)("after %s", async (_name, options, reason) => {
      const result = await unfiltered(options, reason);
      expect(result.commits).toContain("c1");
      expect(result.paths).toContain("lib/after.ts");
    });

    it("after git reset --soft or --mixed on the mainline, which turns the turn's commit back into untouched-looking paths", async () => {
      const result = await unfiltered(
        {
          mainline: true,
          parkHead: "c1",
          uncommitted: ["lib/turn.ts"],
          // The checkout is back at the turn-start head, so c1 is no longer an ancestor of it.
          ancestry: () => ({
            outcome: "available",
            workspace: {
              workingTree: { files: [] },
              branch: { currentBranch: "master", defaultBranch: "master" },
              checkout: { kind: "branch", branchName: "master", headSha: "h0" },
              mergeBase: { files: [], mergeBaseBranch: "c1", baseRef: "h0", aheadCount: 0, commits: [] },
            },
          }),
        },
        "the checkout does not descend from the park head",
      );
      expect(result.paths).toEqual(["lib/turn.ts"]);
    });

    it("when the list of the turn's commits is capped", async () => {
      const chain = Array.from({ length: 20 }, (_, at) => ({ sha: `c${at}`, paths: [`lib/f${at}.ts`], authoredAt: 20_000 }));
      const result = await unfiltered({ chain, parkedAfter: 20, uncommitted: ["lib/after.ts"] }, "the turn's commits or timeline may be incomplete");
      expect(result.paths).toContain("lib/after.ts");
    });

    it("when a commit of the turn made before the park has paths that could not be read", async () => {
      const result = await unfiltered(
        { chain: [{ sha: "c1", paths: null, authoredAt: 20_000 }], parkedAfter: 1, uncommitted: ["lib/c1file.ts"] },
        "a commit made before the park has paths that could not be read",
      );
      expect(result.paths).toEqual(["lib/c1file.ts"]);
    });

    it("when the thread's own tool edited a file after the park, as a wake-up turn does", async () => {
      const result = await unfiltered(
        { ...afterPark, timelines: { self: [opaque, edit("lib/elsewhere.ts", 40_000)] } },
        "the thread's family was active since the park",
      );
      expect(result.paths).toContain("lib/after.ts");
    });

    it("when the status call fails", async () => {
      await unfiltered(
        { ...rewritten, ancestry: () => Promise.reject(new Error("status unavailable")) },
        "the status call failed",
      );
    });

    it("when the thread's timeline can no longer be read back past the turn start", async () => {
      // The first read is the turn's own; the family check pages it again.
      await unfiltered({ ...afterPark, selfReads: 1 }, "the thread's earlier timeline could not be read");
    });

    it("when a kin thread edited a file after the park", async () => {
      const kid = entry("kid", { parentThreadId: "self" });
      const result = await unfiltered(
        { ...afterPark, entries: [self, kid], timelines: { self: [opaque], kid: [edit("lib/kid.ts", 40_000)] } },
        "the thread's family was active since the park",
      );
      expect(result.paths).toContain("lib/after.ts");
    });

    it("when a kin thread could not be read in full", async () => {
      const kid = entry("kid", { parentThreadId: "self" });
      await unfiltered(
        { ...afterPark, entries: [self, kid], timelines: { self: [opaque], kid: new Error("gone") } },
        "a related thread could not be read in full",
      );
    });

    it("leaves the filter on for a quiet kin thread", async () => {
      const kid = entry("kid", { parentThreadId: "self" });
      const chat = { kind: "message", id: "m1", createdAt: 12_000 };
      const { result } = await released({ ...sweepOnly, ...afterPark, entries: [self, kid], timelines: { self: [chat, opaque], kid: [edit("lib/kid.ts", 12_000)] } });
      expect(result).toMatchObject({ commits: [], parkedCommits: ["c1"] });
      expect([...result.parkedPaths].sort()).toEqual(["lib/after.ts", "lib/new.ts"]);
    });

    it("when a row from an earlier turn, before the turn's cursor, is still open", async () => {
      // Started long before the turn and never finished: a seq-based read would stop at the turn's cursor and miss it.
      const open = rowAt({ workKind: "command", approvalStatus: null, command: "make watch", cwd: "/w", status: "pending", sourceSeqStart: 1 }, 2_000, 2_500);
      const result = await unfiltered(
        { ...afterPark, timelines: { self: [opaque, { ...open, completedAt: null }] } },
        "the thread's family was active since the park",
      );
      expect(result.paths).toContain("lib/after.ts");
    });

    it.each([
      ["a command that backgrounds a process", "npm run dev &", "&"],
      ["nohup", "nohup ./serve.sh > out.log", "nohup"],
      ["setsid", "setsid ./serve.sh", "setsid"],
      ["a detached container", "docker compose up -d", "docker … up"],
      ["a detached container with a flag", "docker run -d --name db postgres", "docker … -d"],
      ["a detached tmux session", "tmux new-session -d -s dev 'npm run dev'", "tmux"],
      ["a scheduled job", "at now + 1 minute", "at"],
      ["a supervised process", "pm2 start app.js", "pm2"],
    ])("when the family ran %s that ended before the park", async (_name, text, word) => {
      const detached = rowAt({ workKind: "command", approvalStatus: null, command: text, cwd: "/w" }, 11_000);
      const result = await unfiltered(
        { ...afterPark, timelines: { self: [opaque, detached] } },
        `thread self ran work that may have kept writing after it returned (${word})`,
      );
      expect(result.paths).toContain("lib/after.ts");
    });

    // The reason names the thread and what tripped it, never the command's text.
    it("names the matched word and the thread, not the command", async () => {
      const secret = rowAt({ workKind: "command", approvalStatus: null, command: "API_KEY=hunter2 tmux new -d x", cwd: "/w" }, 11_000);
      const { infos } = await released({ ...sweepOnly, ...afterPark, timelines: { self: [opaque, secret] } });
      expect(infos.join("\n")).toContain("thread self ran work that may have kept writing after it returned (tmux)");
      expect(infos.join("\n")).not.toContain("hunter2");
    });

    it("names a container flag by a fixed label, never by its text", async () => {
      const exec = rowAt({ workKind: "command", approvalStatus: null, command: "docker exec db mysql -uroot -pSecretpassword", cwd: "/w" }, 11_000);
      const { infos } = await released({ ...sweepOnly, ...afterPark, timelines: { self: [opaque, exec] } });
      expect(infos.join("\n")).toContain("thread self ran work that may have kept writing after it returned (docker … -d)");
      expect(infos.join("\n")).not.toContain("Secretpassword");
    });

    const stillWrites = "thread self ran work that may have kept writing after it returned";
    const task = (taskStatus: string, completedAt: number | null) =>
      rowAt({ workKind: "workflow", taskStatus, taskType: "t", workflowName: null }, 11_000, completedAt as number);

    it.each([
      ["running", task("running", null)],
      ["paused", task("paused", null)],
      ["finished after the park", task("completed", 31_000)],
      ["finished at an unknown time", task("failed", null)],
      ["queued", task("queued", 12_000)],
    ])("when a workflow task was %s", async (_name, row) => {
      await unfiltered({ ...afterPark, timelines: { self: [opaque, row] } }, `${stillWrites} (workflow task)`);
    });

    it.each(["completed", "failed", "killed", "stopped"])("leaves the filter on for a workflow task that was %s before the park", async (state) => {
      const { result } = await released({ ...sweepOnly, ...afterPark, timelines: { self: [opaque, task(state, 12_000)] } });
      expect(result.parkedCommits).toEqual(["c1"]);
    });

    it.each([
      ["a tool that is not known to be read-only", rowAt({ workKind: "tool", approvalStatus: null, toolName: "apply", toolArgs: { path: "x" } }, 11_000), "tool apply"],
      ["an extension call", rowAt({ workKind: "extension", callId: "call-1", extensionKind: "mcp/tool" }, 11_000), "extension call"],
    ])("when the family ran %s", async (_name, row, why) => {
      await unfiltered({ ...afterPark, timelines: { self: [opaque, row] } }, `${stillWrites} (${why})`);
    });

    it("leaves the filter on for a tool that is known to be read-only", async () => {
      const read = rowAt({ workKind: "tool", approvalStatus: null, toolName: "Read", toolArgs: { path: "x" } }, 11_000);
      const { result } = await released({ ...sweepOnly, ...afterPark, timelines: { self: [opaque, read] } });
      expect(result.parkedCommits).toEqual(["c1"]);
    });

    it("when the family started something while the files were hashed", async () => {
      // Reads of the thread's timeline: the turn's own, the first quiet check, the second.
      await unfiltered(
        { ...afterPark, lateRows: { reads: 2, rows: [edit("lib/elsewhere.ts", 40_000)] } },
        "the thread's family was active since the park",
      );
    });

    it.each([
      ["mainline", true],
      ["branch", false],
    ])("when the status call reports more commits ahead than it lists, on a %s checkout", async (_name, mainline) => {
      await unfiltered(
        { mainline, aheadCount: 3, timelines: { self: [opaque] }, uncommitted: ["lib/after.ts"], chain: [{ sha: "c1", paths: ["lib/new.ts"], authoredAt: 35_000 }] },
        "the turn's commits or timeline may be incomplete",
      );
    });

    it.each([
      ["a window", edit("lib/kid.ts", 40_000), "the thread's family was active since the park"],
      ["a detached command", rowAt({ workKind: "command", approvalStatus: null, command: "docker compose up -d", cwd: "/w" }, 12_000), "thread kid ran work that may have kept writing after it returned (docker … up)"],
    ])("when a kin thread gained %s between the two quiet reads", async (_name, row, reason) => {
      const kid = entry("kid", { parentThreadId: "self" });
      await unfiltered(
        { ...afterPark, entries: [self, kid], timelines: { self: [opaque], kid: [] }, lateRows: { threadId: "kid", reads: 1, rows: [row] } },
        reason,
      );
    });

    it("when a branch turn started at the base, with no commits ahead, and committed before the park", async () => {
      // The park list holds only the new commit: nothing shows it reaches back to the turn-start head, which is the base.
      await unfiltered(
        {
          ...afterPark,
          turnCommits: { commits: [] },
          parkCommits: { commits: ["c1"] },
          parkedAfter: 1,
          chain: [{ sha: "c1", paths: ["lib/mine.ts"], authoredAt: 20_000 }],
        },
        "the park snapshot's commit lists do not reach back to the turn-start head",
      );
    });

    it("when the park snapshot's commit window does not reach back to the turn-start head", async () => {
      // The turn started with no recent commits; the window at the park holds only a newer one, so a dropped commit may lie outside it.
      await unfiltered(
        {
          ...afterPark,
          mainline: true,
          turnCommits: { recentCommits: [] },
          parkCommits: { recentCommits: [recent("later")] },
          parkedAfter: 1,
          chain: [{ sha: "c1", paths: ["lib/new.ts"], authoredAt: 5_000 }],
        },
        "the park snapshot's commit lists do not reach back to the turn-start head",
      );
    });

    it("when a commit made before the park that the turn's own list dropped has paths that could not be read", async () => {
      await unfiltered(
        { ...afterPark, turnCommits: { commits: ["h0"] }, parkCommits: { commits: ["h0", "c1"] }, parkedAfter: 1, chain: [{ sha: "c1", paths: null, authoredAt: 5_000 }] },
        "a commit made before the park has paths that could not be read",
      );
    });

    it.each([
      ["names none of them", { parkCommits: { commits: [] } }, "the park snapshot's commit lists do not reach back to the turn-start head"],
      ["names too many of them", { parkCommits: { commits: ["h0", ...Array.from({ length: 21 }, (_, at) => `p${at}`)] } }, "too many commits were made before the park to read"],
    ] as Array<[string, Options, string]>)("when the park snapshot %s", async (_name, options, reason) => {
      await unfiltered(
        { ...afterPark, parkedAfter: 1, chain: [{ sha: "c1", paths: ["lib/new.ts"], authoredAt: 20_000 }], ...options },
        reason,
      );
    });

    it("leaves the filter on for a delegation that ran in the foreground", async () => {
      const delegation = rowAt({ workKind: "delegation", callId: "c1", toolName: "Agent", childRef: null, childRows: [], background: false }, 11_000);
      const { result } = await released({ ...sweepOnly, ...afterPark, timelines: { self: [opaque, delegation] } });
      expect(result.parkedCommits).toEqual(["c1"]);
    });

    it("when the family started a background delegation", async () => {
      const delegation = rowAt({ workKind: "delegation", callId: "c1", toolName: "Agent", childRef: null, childRows: [], background: true }, 11_000);
      await unfiltered({ ...afterPark, timelines: { self: [opaque, delegation] } }, `${stillWrites} (background delegation)`);
    });

    it.each([
      ["no park", { park: null }],
      ["no start time", { startedAt: null }],
    ] as Array<[string, Options]>)("when the turn has %s", async (_name, options) => {
      const { result } = await released({ ...sweepOnly, ...afterPark, ...options });
      expect(result).toMatchObject({ ...noneParked, commits: ["c1"] });
    });
  });
});
