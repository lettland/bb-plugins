import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
} from "@get-bb/plugin-sdk/testing";
import { registerAutoReviewCli } from "./cli.js";
import {
  defineAutoReviewSettings,
  type GlobalDefaults,
  type LastFire,
} from "./config.js";

const THREAD_ID = "thread-1";
const OTHER_ID = "thread-2";
const PROJECT_ID = "project-1";

/** A thread's project id, or a richer set of `threads.get` field overrides. */
type ThreadFixture = string | ({ projectId: string } & Record<string, unknown>);

interface CliHostOptions {
  /** Threads the fake host knows, mapped to their project (or full fixture). */
  threads?: Record<string, ThreadFixture>;
  globals?: GlobalDefaults;
}

function createCliHost(options: CliHostOptions = {}) {
  const threads = options.threads ?? {
    [THREAD_ID]: PROJECT_ID,
    [OTHER_ID]: "project-2",
  };
  const metadataByThread = new Map<string, Record<string, unknown>>();
  const known = (threadId: string): Record<string, unknown> => {
    if (!(threadId in threads)) {
      throw new Error(`thread ${threadId} not found`);
    }
    let bucket = metadataByThread.get(threadId);
    if (bucket === undefined) {
      bucket = {};
      metadataByThread.set(threadId, bucket);
    }
    return bucket;
  };

  const sdk: CreateFakePluginHostOptions["sdk"] = {
    threads: {
      get: async (args: { threadId: string }) => {
        known(args.threadId);
        const fixture = threads[args.threadId] as ThreadFixture;
        const overrides = typeof fixture === "string" ? { projectId: fixture } : fixture;
        return {
          ...makeThreadResponse({ id: args.threadId }),
          ...overrides,
        };
      },
      getPluginMetadata: async (args: { threadId: string }) => ({
        ...known(args.threadId),
      }),
      updatePluginMetadata: async (args: {
        threadId: string;
        set?: Record<string, unknown>;
        remove?: string[];
      }) => {
        const target = known(args.threadId);
        Object.assign(target, args.set ?? {});
        for (const key of args.remove ?? []) {
          delete target[key];
        }
        return { ...target };
      },
    },
  };

  const fake = createFakePluginHost({ pluginId: "auto-review", sdk });
  const settings = defineAutoReviewSettings(fake.bb);
  let globals: GlobalDefaults = options.globals ?? {
    enabled: true,
    mergeEligibleMainlines: ["master"],
    reviewMode: "auto",
  };
  registerAutoReviewCli(fake.bb, settings, () => globals);

  return {
    ...fake,
    settings,
    kv: fake.bb.storage.kv,
    metadataFor: known,
    setGlobals: (next: GlobalDefaults) => {
      globals = next;
    },
    run: (argv: string[], threadId?: string) =>
      fake.harness.runCli(argv, threadId === undefined ? {} : { threadId }),
  };
}

type CliHost = ReturnType<typeof createCliHost>;

function parse<T = Record<string, unknown>>(stdout: string | undefined): T {
  return JSON.parse(stdout ?? "") as T;
}

function lastFire(overrides: Partial<LastFire> = {}): LastFire {
  return {
    at: Date.UTC(2026, 0, 2, 3, 4, 5),
    outcome: "fired",
    reason: "fired",
    commit: true,
    merge: false,
    base: "master",
    isWorktree: true,
    scopePaths: ["src/a.ts"],
    ...overrides,
  };
}

async function withHost(
  options: CliHostOptions,
  body: (host: CliHost) => Promise<void>,
): Promise<void> {
  const host = createCliHost(options);
  try {
    await body(host);
  } finally {
    await host.harness.dispose();
  }
}

describe("auto-review cli: dispatch", () => {
  it("prints usage and exits 2 for an unknown command", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["frobnicate"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Usage: bb auto-review <status|show|enable");
      expect(result.stdout).toBe("");
    });
  });

  it("prints usage when no command is given", async () => {
    await withHost({}, async (host) => {
      const result = await host.run([]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Usage:");
    });
  });
});

describe("auto-review cli: enable / disable", () => {
  it("defaults to the global scope and flips the global setting", async () => {
    await withHost({}, async (host) => {
      const disabled = await host.run(["disable"]);
      expect(disabled.exitCode).toBe(0);
      expect(disabled.stdout).toBe("Auto-review disabled globally.\n");
      expect((await host.settings.get()).enabled).toBe(false);

      const enabled = await host.run(["enable", "--global"]);
      expect(enabled.stdout).toBe("Auto-review enabled globally.\n");
      expect((await host.settings.get()).enabled).toBe(true);
    });
  });

  it("reports the global change as JSON", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["disable", "--global", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(parse(result.stdout)).toEqual({
        ok: true,
        scope: "global",
        enabled: false,
      });
    });
  });

  it("writes a project override without touching the global setting", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["disable", "--project", "project-9"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Auto-review disabled for project project-9.\n");
      expect(await host.kv.get("project:project-9")).toEqual({ enabled: false });
      expect((await host.settings.get()).enabled).toBe(true);

      const reenabled = await host.run(["enable", "--project", "project-9"]);
      expect(reenabled.stdout).toBe("Auto-review enabled for project project-9.\n");
      expect(await host.kv.get("project:project-9")).toEqual({ enabled: true });
    });
  });

  it("merges into an existing project override instead of replacing it", async () => {
    await withHost({}, async (host) => {
      await host.kv.set("project:project-9", {
        reviewMode: "self",
        mergeEligibleMainlines: ["trunk"],
      });
      const result = await host.run(["enable", "--project=project-9", "--json"]);
      expect(parse(result.stdout)).toEqual({
        ok: true,
        scope: "project",
        projectId: "project-9",
        enabled: true,
      });
      expect(await host.kv.get("project:project-9")).toEqual({
        reviewMode: "self",
        mergeEligibleMainlines: ["trunk"],
        enabled: true,
      });
    });
  });

  it("replaces a corrupt project override rather than merging garbage", async () => {
    await withHost({}, async (host) => {
      await host.kv.set("project:project-9", { enabled: "yes", reviewMode: 7 });
      await host.run(["disable", "--project", "project-9"]);
      expect(await host.kv.get("project:project-9")).toEqual({ enabled: false });
    });
  });

  it("resolves a bare --project to the invoking thread's project", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["disable", "--project", "--json"], THREAD_ID);
      expect(parse(result.stdout)).toMatchObject({
        scope: "project",
        projectId: PROJECT_ID,
      });
      expect(await host.kv.get(`project:${PROJECT_ID}`)).toEqual({ enabled: false });
    });
  });

  it("requires a project id for a bare --project outside a thread", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["enable", "--project"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("A project id is required");
      expect(await host.kv.list("project:")).toEqual([]);
    });
  });

  it("rejects --global together with --project and changes nothing", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["disable", "--project=project-9", "--global"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Specify only one of --global or --project");
      expect((await host.settings.get()).enabled).toBe(true);
      expect(await host.kv.list("project:")).toEqual([]);
    });
  });
});

describe("auto-review cli: skip / unskip (removed)", () => {
  it.each(["skip", "unskip"])("exits 2 with the removal message for %s", async (command) => {
    await withHost({}, async (host) => {
      const result = await host.run([command, THREAD_ID]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe(
        `\`${command}\` was removed: auto-review reviews every turn and plan.\n`,
      );
      expect(result.stdout).toBe("");
      expect(host.metadataFor(THREAD_ID)).not.toHaveProperty("skip");
    });
  });

  it("is not listed in the usage text", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["frobnicate"]);
      expect(result.stderr).toContain("<status|show|enable|disable|reset>");
    });
  });
});

describe("auto-review cli: reset", () => {
  it("clears a latch, a leftover skip flag and the plan gate, keeping unrelated keys", async () => {
    await withHost({}, async (host) => {
      Object.assign(host.metadataFor(THREAD_ID), {
        phase: "awaiting-review",
        turnStart: { sinceSeq: 4 },
        pendingEntryId: "qm-1",
        dispatchedAt: 1,
        skip: true,
        planReviewArmedAt: 2,
        planReviewEntryId: "qm-2",
        planDenied: { at: 3, sinceSeq: 4 },
        unrelated: "kept",
      });
      const result = await host.run(["reset", THREAD_ID]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`reset ${THREAD_ID} (cleared awaiting-review latch).\n`);
      expect(host.metadataFor(THREAD_ID)).toEqual({ phase: "idle", unrelated: "kept" });
    });
  });

  it.each(["active", "starting", "stopping"])(
    "refuses to reset a %s thread and leaves its state alone",
    async (status) => {
      await withHost(
        { threads: { [THREAD_ID]: { projectId: PROJECT_ID, status } } },
        async (host) => {
          Object.assign(host.metadataFor(THREAD_ID), {
            phase: "awaiting-review",
            turnStart: { sinceSeq: 4 },
          });
          const text = await host.run(["reset", THREAD_ID]);
          expect(text.exitCode).toBe(2);
          expect(text.stderr).toBe("reset only clears a stuck latch on an idle thread\n");
          expect(text.stdout).toBe("");

          const payload = await host.run(["reset", THREAD_ID, "--json"]);
          expect(payload.exitCode).toBe(2);
          expect(parse(payload.stdout)).toEqual({
            ok: false,
            threadId: THREAD_ID,
            error: "reset only clears a stuck latch on an idle thread",
          });
          expect(host.metadataFor(THREAD_ID)).toEqual({
            phase: "awaiting-review",
            turnStart: { sinceSeq: 4 },
          });
        },
      );
    },
  );

  it("reports an already-idle thread as nothing latched", async () => {
    await withHost({}, async (host) => {
      const text = await host.run(["reset", THREAD_ID]);
      expect(text.stdout).toBe(`reset ${THREAD_ID} (was already idle; nothing latched).\n`);

      const payload = await host.run(["reset", THREAD_ID, "--json"]);
      expect(parse(payload.stdout)).toEqual({
        ok: true,
        command: "reset",
        threadId: THREAD_ID,
        priorPhase: "idle",
        wasLatched: false,
        droppedDeferral: false,
      });
    });
  });

  it("drops a deferred turn together with its deferral index entry", async () => {
    await withHost({}, async (host) => {
      Object.assign(host.metadataFor(THREAD_ID), {
        phase: "deferred",
        deferredSince: 5,
        turnStart: { sinceSeq: 0 },
      });
      await host.kv.set(`deferral:${THREAD_ID}`, {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        environmentId: "env-1",
      });
      await host.kv.set(`deferral:${OTHER_ID}`, {
        threadId: OTHER_ID,
        projectId: PROJECT_ID,
        environmentId: "env-1",
      });

      const result = await host.run(["reset", THREAD_ID]);
      expect(result.stdout).toContain(`reset ${THREAD_ID} (dropped a deferred turn).`);
      expect(result.stdout).toContain("will now never run");
      expect(host.metadataFor(THREAD_ID)).toEqual({ phase: "idle" });
      expect(await host.kv.list("deferral:")).toEqual([`deferral:${OTHER_ID}`]);
    });
  });

  it("drops a child-held deferred turn with wording naming the children", async () => {
    await withHost({}, async (host) => {
      Object.assign(host.metadataFor(THREAD_ID), {
        phase: "deferred",
        deferredSince: 5,
        turnStart: { sinceSeq: 0 },
        heldBy: ["child-1"],
      });
      const result = await host.run(["reset", THREAD_ID]);
      expect(result.stdout).toContain(`reset ${THREAD_ID} (dropped a deferred turn).`);
      expect(result.stdout).toContain(
        "waiting for child threads to finish (child-1), not stuck",
      );
      expect(result.stdout).toContain("will now never run");
    });
  });

  it("flags the dropped deferral in JSON", async () => {
    await withHost({}, async (host) => {
      Object.assign(host.metadataFor(THREAD_ID), { phase: "deferred" });
      const result = await host.run(["reset", THREAD_ID, "--json"]);
      expect(parse(result.stdout)).toMatchObject({
        priorPhase: "deferred",
        wasLatched: true,
        droppedDeferral: true,
      });
    });
  });

  it("treats unparseable thread state as idle and still resets it", async () => {
    await withHost({}, async (host) => {
      Object.assign(host.metadataFor(THREAD_ID), { phase: "exploded" });
      const result = await host.run(["reset", THREAD_ID, "--json"]);
      expect(parse(result.stdout)).toMatchObject({ priorPhase: "idle", wasLatched: false });
      expect(host.metadataFor(THREAD_ID).phase).toBe("idle");
      expect(
        host.harness.logEntries.some((entry) =>
          entry.message.includes(`unparseable thread state for ${THREAD_ID}`),
        ),
      ).toBe(true);
    });
  });

  it("resets the thread named after --json, not the invoking thread", async () => {
    await withHost({}, async (host) => {
      Object.assign(host.metadataFor(THREAD_ID), { phase: "awaiting-review" });
      Object.assign(host.metadataFor(OTHER_ID), { phase: "awaiting-review" });
      const result = await host.run(["reset", "--json", OTHER_ID], THREAD_ID);
      expect(parse(result.stdout)).toMatchObject({ threadId: OTHER_ID });
      expect(host.metadataFor(OTHER_ID).phase).toBe("idle");
      expect(host.metadataFor(THREAD_ID).phase).toBe("awaiting-review");
    });
  });

  it("reports an unknown thread instead of throwing", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["reset", "ghost"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("Thread ghost not found or unavailable.\n");
    });
  });
});

describe("auto-review cli: status", () => {
  it("requires a thread id outside a thread", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["status", "--json"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("A thread id is required: bb auto-review status");
    });
  });

  it("reports an unknown thread as text and as JSON", async () => {
    await withHost({}, async (host) => {
      const text = await host.run(["status", "ghost"]);
      expect(text.exitCode).toBe(1);
      expect(text.stderr).toBe("Thread ghost not found or unavailable.\n");

      const payload = await host.run(["status", "ghost", "--json"]);
      expect(payload.exitCode).toBe(1);
      expect(parse(payload.stdout)).toMatchObject({ ok: false, threadId: "ghost" });
    });
  });

  it("prints the effective state of a fresh thread with no fire yet", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["status"], THREAD_ID);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        "enabled: true\n" +
          "reviewMode: auto\n" +
          "mergeEligibleMainlines: master\n" +
          "planGate: false\n" +
          "phase: idle\n" +
          "lastFire: never\n",
      );
    });
  });

  it("layers the project override over the globals and ignores an old skip flag", async () => {
    await withHost(
      {
        globals: {
          enabled: true,
          mergeEligibleMainlines: ["master", "main"],
          reviewMode: "devkit",
        },
      },
      async (host) => {
        await host.kv.set(`project:${PROJECT_ID}`, { enabled: false, reviewMode: "self" });
        host.metadataFor(THREAD_ID).skip = true;
        const result = await host.run(["status", THREAD_ID, "--json"]);
        expect(parse(result.stdout)).toEqual({
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          enabled: false,
          reviewMode: "self",
          mergeEligibleMainlines: ["master", "main"],
          planGate: false,
          phase: "idle",
          deferredSince: null,
          heldBy: null,
          lastFire: null,
        });
      },
    );
  });

  it("reads the globals afresh on every call", async () => {
    await withHost({}, async (host) => {
      host.setGlobals({ enabled: false, mergeEligibleMainlines: ["trunk"], reviewMode: "self" });
      const result = await host.run(["status", THREAD_ID]);
      expect(result.stdout).toContain("enabled: false\n");
      expect(result.stdout).toContain("mergeEligibleMainlines: trunk\n");
    });
  });

  it("describes the last fire of this thread in its own project", async () => {
    await withHost({}, async (host) => {
      await host.kv.set(`lastfire:${PROJECT_ID}:${THREAD_ID}`, lastFire({
        outcome: "stood-down",
        reason: "no-authorship",
      }));
      // Same thread id under another project must not leak in.
      await host.kv.set(`lastfire:project-2:${THREAD_ID}`, lastFire());
      const result = await host.run(["status", THREAD_ID]);
      expect(result.stdout).toContain(
        "lastFire: stood-down (no-authorship) at 2026-01-02T03:04:05.000Z\n",
      );
    });
  });

  it("ignores a corrupt last-fire record", async () => {
    await withHost({}, async (host) => {
      await host.kv.set(`lastfire:${PROJECT_ID}:${THREAD_ID}`, { outcome: "fired" });
      const result = await host.run(["status", THREAD_ID, "--json"]);
      expect(parse(result.stdout).lastFire).toBeNull();
    });
  });

  it("still shows a stored last fire whose reason is the legacy skipped", async () => {
    await withHost({}, async (host) => {
      await host.kv.set(
        `lastfire:${PROJECT_ID}:${THREAD_ID}`,
        lastFire({ outcome: "stood-down", reason: "skipped" }),
      );
      const text = await host.run(["status", THREAD_ID]);
      expect(text.stdout).toContain("lastFire: stood-down (skipped) at ");
      const payload = await host.run(["status", THREAD_ID, "--json"]);
      expect(parse(payload.stdout)).toMatchObject({
        lastFire: { outcome: "stood-down", reason: "skipped" },
      });
    });
  });

  it("explains how long a deferred turn has waited and how to drop it", async () => {
    await withHost({}, async (host) => {
      const deferredSince = Date.now() - 7 * 60_000 - 5_000;
      Object.assign(host.metadataFor(THREAD_ID), { phase: "deferred", deferredSince });
      const text = await host.run(["status", THREAD_ID]);
      expect(text.stdout).toContain("phase: deferred\ndeferred for: 7 min — ");
      expect(text.stdout).toContain("It fires automatically as soon as that review ends.");
      expect(text.stdout).toContain(`To drop it instead: bb auto-review reset ${THREAD_ID}\n`);

      const payload = await host.run(["status", THREAD_ID, "--json"]);
      expect(parse(payload.stdout)).toMatchObject({ phase: "deferred", deferredSince });
    });
  });

  it("omits the wait line for a deferred turn with no timestamp", async () => {
    await withHost({}, async (host) => {
      Object.assign(host.metadataFor(THREAD_ID), { phase: "deferred" });
      const text = await host.run(["status", THREAD_ID]);
      expect(text.stdout).toContain("phase: deferred\nlastFire: never\n");
    });
  });

  it("explains a child-held deferred turn and names the children", async () => {
    await withHost({}, async (host) => {
      const deferredSince = Date.now() - 3 * 60_000;
      Object.assign(host.metadataFor(THREAD_ID), {
        phase: "deferred",
        deferredSince,
        heldBy: ["child-1", "child-2"],
      });
      const text = await host.run(["status", THREAD_ID]);
      expect(text.stdout).toContain("phase: deferred\ndeferred for: 3 min — ");
      expect(text.stdout).toContain(
        "held by child threads (as of the last check): child-1, child-2\n",
      );
      expect(text.stdout).toContain(
        "It is reviewed when this thread next goes idle after bb wakes it for the last of them ending, " +
          "or by the 5-minute sweep once all of them have ended (idle, errored, archived or deleted).",
      );
      expect(text.stdout).toContain(
        "Stop or archive a stuck child to release it — the turn is then re-checked for review.",
      );
      expect(text.stdout).toContain(`To drop it instead: bb auto-review reset ${THREAD_ID}\n`);
      expect(text.stdout).not.toContain("waiting for another auto-review on the same provider");

      const payload = await host.run(["status", THREAD_ID, "--json"]);
      expect(parse(payload.stdout)).toMatchObject({
        phase: "deferred",
        heldBy: ["child-1", "child-2"],
      });
    });
  });

  it("does not let --json swallow the thread id that follows it", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["status", "--json", OTHER_ID], THREAD_ID);
      expect(result.exitCode).toBe(0);
      expect(parse(result.stdout)).toMatchObject({
        threadId: OTHER_ID,
        projectId: "project-2",
      });
    });
  });
});

describe("auto-review cli: status — planGate", () => {
  const claudeCodeThread: ThreadFixture = {
    projectId: PROJECT_ID,
    providerId: "claude-code",
    environmentId: "env-1",
  };

  it("is true for a top-level, enabled claude-code thread", async () => {
    await withHost({ threads: { [THREAD_ID]: claudeCodeThread } }, async (host) => {
      const result = await host.run(["status", THREAD_ID, "--json"]);
      expect(parse(result.stdout)).toMatchObject({ planGate: true });
    });
  });

  it("is false for a different provider (e.g. the ACP bridge)", async () => {
    await withHost(
      { threads: { [THREAD_ID]: { ...claudeCodeThread, providerId: "acp-claude-work" } } },
      async (host) => {
        const result = await host.run(["status", THREAD_ID, "--json"]);
        expect(parse(result.stdout)).toMatchObject({ planGate: false });
      },
    );
  });

  it("is true for a thread carrying a skip flag from old stored state", async () => {
    await withHost({ threads: { [THREAD_ID]: claudeCodeThread } }, async (host) => {
      host.metadataFor(THREAD_ID).skip = true;
      const result = await host.run(["status", THREAD_ID, "--json"]);
      expect(parse(result.stdout)).toMatchObject({ planGate: true });
    });
  });

  it("is false when disabled for the project", async () => {
    await withHost({ threads: { [THREAD_ID]: claudeCodeThread } }, async (host) => {
      await host.kv.set(`project:${PROJECT_ID}`, { enabled: false });
      const result = await host.run(["status", THREAD_ID, "--json"]);
      expect(parse(result.stdout)).toMatchObject({ planGate: false });
    });
  });

  it("is false when disabled globally", async () => {
    await withHost({ threads: { [THREAD_ID]: claudeCodeThread } }, async (host) => {
      host.setGlobals({ enabled: false, mergeEligibleMainlines: ["master"], reviewMode: "auto" });
      const result = await host.run(["status", THREAD_ID, "--json"]);
      expect(parse(result.stdout)).toMatchObject({ planGate: false });
    });
  });

  it("is false for a child thread", async () => {
    await withHost(
      { threads: { [THREAD_ID]: { ...claudeCodeThread, parentThreadId: "thr_parent" } } },
      async (host) => {
        const result = await host.run(["status", THREAD_ID, "--json"]);
        expect(parse(result.stdout)).toMatchObject({ planGate: false });
      },
    );
  });
});

describe("auto-review cli: show", () => {
  it("shows the globals when there is no project in scope", async () => {
    await withHost({}, async (host) => {
      const text = await host.run(["show"]);
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toBe(
        "project: (none)\n" +
          "enabled: true\n" +
          "reviewMode: auto\n" +
          "mergeEligibleMainlines: master\n",
      );

      const payload = await host.run(["show", "--json"]);
      expect(parse(payload.stdout)).toEqual({
        projectId: null,
        globals: { enabled: true, mergeEligibleMainlines: ["master"], reviewMode: "auto" },
        projectOverride: {},
        effective: { enabled: true, reviewMode: "auto", mergeEligibleMainlines: ["master"] },
      });
    });
  });

  it("merges a named project's override over the globals", async () => {
    await withHost({}, async (host) => {
      await host.kv.set("project:project-9", {
        mergeEligibleMainlines: ["trunk", "personal"],
        reviewMode: "devkit",
      });
      const text = await host.run(["show", "--project", "project-9"]);
      expect(text.stdout).toBe(
        "project: project-9\n" +
          "enabled: true\n" +
          "reviewMode: devkit\n" +
          "mergeEligibleMainlines: trunk, personal\n",
      );
    });
  });

  it("resolves the project from the invoking thread", async () => {
    await withHost({}, async (host) => {
      await host.kv.set(`project:${PROJECT_ID}`, { enabled: false });
      const result = await host.run(["show", "--json"], THREAD_ID);
      expect(parse(result.stdout)).toMatchObject({
        projectId: PROJECT_ID,
        projectOverride: { enabled: false },
        effective: { enabled: false },
      });
    });
  });
});
