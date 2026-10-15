import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
} from "@get-bb/plugin-sdk/testing";
import { registerAutoReviewCli } from "./cli.js";
import { MAX_PROMPT_FINDINGS } from "./findings-schema.js";
import { withThreadLock } from "./state.js";
import {
  defineAutoReviewSettings,
  lastFireSchema,
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
  /** Project ids the fake host lists; defaults to the ones the auto-approve tests name. */
  projects?: string[];
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

  const projectIds = options.projects ?? [PROJECT_ID, "project-2", "project-9"];
  const sdk = {
    projects: {
      list: async () => projectIds.map((id) => ({ id, name: id })),
    },
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
  } as unknown as CreateFakePluginHostOptions["sdk"];

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

describe("auto-review cli: auto-approve", () => {
  const USAGE = "Usage: bb auto-review auto-approve <on|off> --project <id> [--json]\n";

  it("turns plan auto-approve on and off for the named project", async () => {
    await withHost({}, async (host) => {
      const on = await host.run(["auto-approve", "on", "--project", "project-9"]);
      expect(on.exitCode).toBe(0);
      expect(on.stdout).toBe("Plan auto-approve on for project project-9.\n");
      expect(await host.kv.get("project:project-9")).toEqual({ autoApprovePlans: true });

      const off = await host.run(["auto-approve", "off", "--project=project-9", "--json"]);
      expect(off.exitCode).toBe(0);
      expect(parse(off.stdout)).toEqual({
        ok: true,
        scope: "project",
        projectId: "project-9",
        autoApprovePlans: false,
      });
      expect(await host.kv.get("project:project-9")).toEqual({ autoApprovePlans: false });
    });
  });

  it("keeps the project's other overrides", async () => {
    await withHost({}, async (host) => {
      await host.kv.set("project:project-9", { enabled: false, reviewMode: "self" });
      await host.run(["auto-approve", "on", "--project", "project-9"]);
      expect(await host.kv.get("project:project-9")).toEqual({
        enabled: false,
        reviewMode: "self",
        autoApprovePlans: true,
      });
    });
  });

  it("never takes the project from the invoking thread", async () => {
    await withHost({}, async (host) => {
      for (const value of ["on", "off"]) {
        const result = await host.run(["auto-approve", value], THREAD_ID);
        expect(result).toMatchObject({
          exitCode: 2,
          stderr:
            "--project <id> is required for auto-approve (it is never inferred from the thread).\n",
        });
      }
      expect(await host.kv.get(`project:${PROJECT_ID}`)).toBeUndefined();
    });
  });

  it("names the missing --project specifically, as JSON under --json", async () => {
    await withHost({}, async (host) => {
      const message =
        "--project <id> is required for auto-approve (it is never inferred from the thread).";
      expect(await host.run(["auto-approve", "on"])).toMatchObject({
        exitCode: 2,
        stderr: `${message}\n`,
      });
      expect(await host.run(["auto-approve", "on", "--project"])).toMatchObject({
        exitCode: 2,
        stderr: `${message}\n`,
      });
      const json = await host.run(["auto-approve", "off", "--json"]);
      expect(json.exitCode).toBe(2);
      expect(parse(json.stdout)).toEqual({ ok: false, command: "auto-approve", error: message });
    });
  });

  it("exits 2 with the usage line for a missing or invalid value, or --global", async () => {
    await withHost({}, async (host) => {
      for (const argv of [
        ["auto-approve", "--project", "project-9"],
        ["auto-approve", "maybe", "--project", "project-9"],
        ["auto-approve", "on", "--global"],
        ["auto-approve", "on", "--global", "--project", "project-9"],
      ]) {
        const result = await host.run(argv);
        expect(result).toMatchObject({ exitCode: 2, stderr: USAGE });
      }
      expect(await host.kv.get("project:project-9")).toBeUndefined();
    });
  });

  it("rejects an unknown project without writing anything", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["auto-approve", "on", "--project", "nope"]);
      expect(result).toMatchObject({ exitCode: 2, stderr: "Project nope not found.\n" });
      expect(await host.kv.get("project:nope")).toBeUndefined();

      const json = await host.run(["auto-approve", "off", "--project", "nope", "--json"]);
      expect(json.exitCode).toBe(2);
      expect(parse(json.stdout)).toEqual({
        ok: false,
        command: "auto-approve",
        projectId: "nope",
        error: "Project nope not found.",
      });
      expect(await host.kv.get("project:nope")).toBeUndefined();
    });
  });

  it("refuses to turn it on from inside a thread, but lets off through", async () => {
    await withHost({}, async (host) => {
      const refusal =
        "Turning plan auto-approve on is only allowed from the settings page (Tools → Auto review → Plan auto-approve) or a terminal outside a bb thread.";
      const on = await host.run(["auto-approve", "on", "--project", PROJECT_ID], THREAD_ID);
      expect(on).toMatchObject({ exitCode: 2, stderr: `${refusal}\n` });
      expect(await host.kv.get(`project:${PROJECT_ID}`)).toBeUndefined();

      const json = await host.run(["auto-approve", "on", "--project", PROJECT_ID, "--json"], THREAD_ID);
      expect(json.exitCode).toBe(2);
      expect(parse(json.stdout)).toEqual({
        ok: false,
        command: "auto-approve",
        projectId: PROJECT_ID,
        error: refusal,
      });

      await host.kv.set(`project:${PROJECT_ID}`, { autoApprovePlans: true });
      const off = await host.run(["auto-approve", "off", "--project", PROJECT_ID], THREAD_ID);
      expect(off).toMatchObject({ exitCode: 0 });
      expect(await host.kv.get(`project:${PROJECT_ID}`)).toEqual({ autoApprovePlans: false });
    });
  });

  it("logs whether the change came from a thread or a terminal", async () => {
    await withHost({}, async (host) => {
      await host.run(["auto-approve", "on", "--project", PROJECT_ID]);
      await host.run(["auto-approve", "off", "--project", PROJECT_ID], THREAD_ID);
      const info = host.harness.logEntries
        .filter((entry) => entry.level === "info")
        .map((entry) => entry.message);
      expect(info).toContain(`plan auto-approve for project ${PROJECT_ID}: false -> true (via cli (terminal))`);
      expect(info).toContain(
        `plan auto-approve for project ${PROJECT_ID}: true -> false (via cli (thread ${THREAD_ID}))`,
      );
    });
  });

  it("is reflected by status and show", async () => {
    await withHost({}, async (host) => {
      await host.run(["auto-approve", "on", "--project", PROJECT_ID]);
      const status = await host.run(["status", THREAD_ID, "--json"]);
      expect(parse(status.stdout)).toMatchObject({ autoApprovePlans: true });
      expect((await host.run(["status", THREAD_ID])).stdout).toContain("autoApprovePlans: true\n");

      const show = await host.run(["show", "--project", PROJECT_ID, "--json"]);
      expect(parse(show.stdout)).toMatchObject({
        projectOverride: { autoApprovePlans: true },
        effective: { autoApprovePlans: true },
      });
      expect((await host.run(["show", "--project", PROJECT_ID])).stdout).toContain(
        "autoApprovePlans: true\n",
      );
    });
  });

  it("shows the plan-approved fire reason in status", async () => {
    await withHost({}, async (host) => {
      await host.kv.set(
        `lastfire:${PROJECT_ID}:${THREAD_ID}`,
        lastFire({ outcome: "fired", reason: "plan-approved" }),
      );
      const result = await host.run(["status", THREAD_ID]);
      expect(result.stdout).toContain("lastFire: fired (plan-approved) at ");
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

  it.each(["skip", "unskip"])("answers %s with a JSON error under --json", async (command) => {
    await withHost({}, async (host) => {
      const result = await host.run([command, THREAD_ID, "--json"]);
      expect(result.exitCode).toBe(2);
      expect(parse(result.stdout)).toEqual({
        ok: false,
        command,
        error: `\`${command}\` was removed: auto-review reviews every turn and plan.`,
      });
      expect(result.stderr ?? "").toBe("");
    });
  });

  it("is not listed in the usage text", async () => {
    await withHost({}, async (host) => {
      const result = await host.run(["frobnicate"]);
      expect(result.stderr).toContain("<status|show|enable|disable|auto-approve|findings|reset>");
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

  it("records a review it cuts off as stopped, leaves the findings alone and clears the delivery keys", async () => {
    await withHost({}, async (host) => {
      const chains = {
        a: {
          key: "a",
          title: "t",
          file: "a.ts",
          severity: "low",
          status: "open",
          firstSeenAt: 1,
          lastSeenAt: 1,
          raisedCount: 1,
          dismissCount: 0,
          reRaised: false,
          lastReviewId: 1,
        },
      };
      await host.kv.set(`findings:${THREAD_ID}`, { chains, incidents: [] });
      Object.assign(host.metadataFor(THREAD_ID), {
        phase: "awaiting-review",
        dispatchedAt: 1,
        reviewDeliveredAt: 5,
        reviewDeliveredSeq: 9,
      });
      await host.run(["reset", THREAD_ID]);
      expect(host.metadataFor(THREAD_ID)).toEqual({ phase: "idle" });
      const stored = (await host.kv.get(`findings:${THREAD_ID}`)) as {
        chains: unknown;
        lastReport: { reviewId: number; outcome: string };
        incidents: unknown[];
      };
      expect(stored.lastReport).toMatchObject({ reviewId: 5, outcome: "stopped" });
      expect(stored.chains).toEqual(chains);
      expect(stored.incidents).toEqual([]);
    });
  });

  it("records a review still queued behind the thread's turn as stopped, so the badge leaves the old outcome", async () => {
    await withHost({}, async (host) => {
      await host.kv.set(`findings:${THREAD_ID}`, {
        chains: {},
        lastReport: { reviewId: 1, at: 1, outcome: "merged", summary: "old", counts: { open: 0, fixed: 0, falsePositive: 0 } },
        incidents: [],
      });
      Object.assign(host.metadataFor(THREAD_ID), {
        phase: "pending-dispatch",
        dispatchedAt: 7,
        pendingEntryId: "qm-1",
      });
      await host.run(["reset", THREAD_ID]);
      expect(host.metadataFor(THREAD_ID)).toEqual({ phase: "idle" });
      const stored = (await host.kv.get(`findings:${THREAD_ID}`)) as {
        lastReport: { reviewId: number; outcome: string };
        incidents: unknown[];
      };
      expect(stored.lastReport).toMatchObject({ reviewId: 7, outcome: "stopped" });
      expect(stored.incidents).toEqual([]);
    });
  });

  it("records nothing when the reset thread was not mid-review", async () => {
    await withHost({}, async (host) => {
      Object.assign(host.metadataFor(THREAD_ID), { phase: "idle" });
      await host.run(["reset", THREAD_ID]);
      expect(await host.kv.list("findings:")).toEqual([]);
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
          const message =
            `thread ${THREAD_ID} is ${status}; reset only clears a stuck latch on an idle thread — ` +
            `wait for the turn to end, then retry.`;
          const text = await host.run(["reset", THREAD_ID]);
          expect(text.exitCode).toBe(2);
          expect(text.stderr).toBe(`${message}\n`);
          expect(text.stdout).toBe("");

          const payload = await host.run(["reset", THREAD_ID, "--json"]);
          expect(payload.exitCode).toBe(2);
          expect(parse(payload.stdout)).toEqual({
            ok: false,
            threadId: THREAD_ID,
            error: message,
          });
          expect(host.metadataFor(THREAD_ID)).toEqual({
            phase: "awaiting-review",
            turnStart: { sinceSeq: 4 },
          });
        },
      );
    },
  );

  it("sees a turn that starts while it waits for the thread lock", async () => {
    const threads: Record<string, ThreadFixture> = {
      [THREAD_ID]: { projectId: PROJECT_ID, status: "idle" },
    };
    await withHost({ threads }, async (host) => {
      Object.assign(host.metadataFor(THREAD_ID), {
        phase: "awaiting-review",
        turnStart: { sinceSeq: 4 },
      });
      // Relies on runCli invoking run synchronously and the fake threads.get reading
      // status at call time, so the old pre-lock check would have read idle here.
      let release: () => void = () => {};
      let entered: () => void = () => {};
      const lockTaken = new Promise<void>((resolve) => (entered = resolve));
      const held = withThreadLock(
        THREAD_ID,
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
            entered();
          }),
      );
      await lockTaken;
      const pending = host.run(["reset", THREAD_ID]);
      // The thread turns active after reset was invoked but before it holds the lock.
      threads[THREAD_ID] = { projectId: PROJECT_ID, status: "active" };
      release();
      await held;

      const result = await pending;
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(`thread ${THREAD_ID} is active;`);
      expect(host.metadataFor(THREAD_ID)).toEqual({
        phase: "awaiting-review",
        turnStart: { sinceSeq: 4 },
      });
    });
  });

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
      });
    });
  });

  it("refuses to reset a deferred turn, leaving its state and deferral index untouched", async () => {
    await withHost({}, async (host) => {
      const deferred = {
        phase: "deferred",
        deferredSince: 5,
        turnStart: { sinceSeq: 0 },
      };
      Object.assign(host.metadataFor(THREAD_ID), deferred);
      for (const id of [THREAD_ID, OTHER_ID]) {
        await host.kv.set(`deferral:${id}`, {
          threadId: id,
          projectId: PROJECT_ID,
          environmentId: "env-1",
        });
      }
      const message =
        `thread ${THREAD_ID} has a deferred turn; its review runs when the hold clears — ` +
        `reset would drop it. Check \`bb auto-review status ${THREAD_ID}\`; if the hold never ` +
        "clears, stop or archive the holding child thread, or send the thread another message " +
        "(a new turn re-checks the deferred one and reviews it).";

      const text = await host.run(["reset", THREAD_ID]);
      expect(text.exitCode).toBe(2);
      expect(text.stderr).toBe(`${message}\n`);
      expect(text.stdout).toBe("");

      const payload = await host.run(["reset", THREAD_ID, "--json"]);
      expect(payload.exitCode).toBe(2);
      expect(parse(payload.stdout)).toEqual({ ok: false, threadId: THREAD_ID, error: message });

      expect(host.metadataFor(THREAD_ID)).toEqual(deferred);
      expect((await host.kv.list("deferral:")).sort()).toEqual([
        `deferral:${THREAD_ID}`,
        `deferral:${OTHER_ID}`,
      ]);
    });
  });

  it("refuses a child-held deferred turn too", async () => {
    await withHost({}, async (host) => {
      Object.assign(host.metadataFor(THREAD_ID), {
        phase: "deferred",
        deferredSince: 5,
        turnStart: { sinceSeq: 0 },
        heldBy: ["child-1"],
      });
      const result = await host.run(["reset", THREAD_ID]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("has a deferred turn");
      expect(host.metadataFor(THREAD_ID).phase).toBe("deferred");
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
          "autoApprovePlans: false\n" +
          "planGate: false\n" +
          "phase: idle\n" +
          "lastFire: never\n" +
          "reviewResult: none\n",
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
          autoApprovePlans: false,
          planGate: false,
          phase: "idle",
          deferredSince: null,
          heldBy: null,
          lastFire: null,
          reviewResult: { status: "none", at: null, summary: null },
          openFindings: 0,
          reRaisedFindings: 0,
          omittedFromPrompt: 0,
          lastIncident: null,
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

  it("still shows a stored last fire whose reason is the legacy commit-plan", async () => {
    await withHost({}, async (host) => {
      await host.kv.set(
        `lastfire:${PROJECT_ID}:${THREAD_ID}`,
        lastFire({ outcome: "stood-down", reason: "commit-plan" }),
      );
      const text = await host.run(["status", THREAD_ID]);
      expect(text.stdout).toContain("lastFire: stood-down (commit-plan) at ");
      const payload = await host.run(["status", THREAD_ID, "--json"]);
      expect(parse(payload.stdout)).toMatchObject({
        lastFire: { outcome: "stood-down", reason: "commit-plan" },
      });
    });
  });

  it("shows the count of changes the thread's family did not make, from a stored last fire that parses through the schema", async () => {
    await withHost({}, async (host) => {
      const stored = lastFire({ outcome: "stood-down", reason: "unclaimed-changes", scopePaths: [], unclaimedCount: 3 });
      expect(lastFireSchema.safeParse(stored).success).toBe(true);
      await host.kv.set(`lastfire:${PROJECT_ID}:${THREAD_ID}`, stored);
      const text = await host.run(["status", THREAD_ID]);
      expect(text.stdout).toContain("lastFire: stood-down (unclaimed-changes) at 2026-01-02T03:04:05.000Z, 3 change(s) not made by this thread's family\n");
      const payload = await host.run(["status", THREAD_ID, "--json"]);
      expect(parse(payload.stdout)).toMatchObject({
        lastFire: { outcome: "stood-down", reason: "unclaimed-changes", unclaimedCount: 3 },
      });
    });
  });

  it("explains how long a deferred turn has waited", async () => {
    await withHost({}, async (host) => {
      const deferredSince = Date.now() - 7 * 60_000 - 5_000;
      Object.assign(host.metadataFor(THREAD_ID), { phase: "deferred", deferredSince });
      const text = await host.run(["status", THREAD_ID]);
      expect(text.stdout).toContain("phase: deferred\ndeferred for: 7 min — ");
      expect(text.stdout).toContain("It fires automatically as soon as that review ends.");
      expect(text.stdout).not.toContain("reset");

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
      expect(text.stdout).not.toContain("reset");
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
          "mergeEligibleMainlines: master\n" +
          "autoApprovePlans: false\n",
      );

      const payload = await host.run(["show", "--json"]);
      expect(parse(payload.stdout)).toEqual({
        projectId: null,
        globals: { enabled: true, mergeEligibleMainlines: ["master"], reviewMode: "auto" },
        projectOverride: {},
        effective: {
          enabled: true,
          reviewMode: "auto",
          mergeEligibleMainlines: ["master"],
          autoApprovePlans: false,
        },
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
          "mergeEligibleMainlines: trunk, personal\n" +
          "autoApprovePlans: false\n",
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

describe("auto-review cli: findings", () => {
  const chain = (key: string, overrides: Record<string, unknown> = {}) => ({
    key,
    title: `title of ${key}`,
    file: "src/a.ts",
    line: 4,
    severity: "medium",
    status: "open",
    firstSeenAt: 1,
    lastSeenAt: 2,
    raisedCount: 1,
    dismissCount: 0,
    reRaised: false,
    lastReviewId: 1,
    ...overrides,
  });
  const store = {
    chains: {
      calm: chain("calm", { status: "fixed" }),
      risky: chain("risky", { severity: "high", status: "false-positive", dismissCount: 2, reason: "r" }),
      back: chain("back", { reRaised: true }),
    },
    lastReport: {
      reviewId: 1,
      at: Date.UTC(2026, 0, 2),
      outcome: "committed",
      summary: "all done",
      counts: { open: 1, fixed: 1, falsePositive: 1 },
    },
    incidents: [{ at: Date.UTC(2026, 0, 3), kind: "not-reported", detail: "no report" }],
  };

  it("lists the chains open first, flags re-raised and repeatedly dismissed ones, and shows incidents", async () => {
    await withHost({}, async (host) => {
      await host.kv.set(`findings:${THREAD_ID}`, store);
      const result = await host.run(["findings"], THREAD_ID);
      expect(result.exitCode).toBe(0);
      const text = result.stdout ?? "";
      expect(text).toContain("lastReport: committed at 2026-01-02T00:00:00.000Z — all done");
      expect(text).toContain("open: 1");
      expect(text.indexOf("back [medium] open")).toBeLessThan(text.indexOf("calm [medium] fixed"));
      expect(text).toContain("re-raised");
      expect(text).toContain("dismissed 2x — worth a second look");
      expect(text).toContain("not-reported: no report");
    });
  });

  it("prints the store as JSON for an explicit thread id", async () => {
    await withHost({}, async (host) => {
      await host.kv.set(`findings:${OTHER_ID}`, store);
      const result = await host.run(["findings", OTHER_ID, "--json"]);
      expect(parse<{ chains: Array<{ key: string }>; lastReport: { outcome: string } }>(result.stdout)).toMatchObject({
        threadId: OTHER_ID,
        lastReport: { outcome: "committed" },
        omittedFromPrompt: 0,
      });
      expect(parse<{ chains: Array<{ key: string }> }>(result.stdout).chains.map((c) => c.key)).toEqual([
        "back",
        "calm",
        "risky",
      ]);
    });
  });

  it("says when open chains are past what the next review lists", async () => {
    await withHost({}, async (host) => {
      const chains = Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`k${index}`, chain(`k${index}`)]),
      );
      await host.kv.set(`findings:${THREAD_ID}`, { chains, incidents: [] });
      const result = await host.run(["findings"], THREAD_ID);
      expect(result.stdout).toContain("open: 17 (the next review lists the first 15; 2 more are not listed)");
    });
  });

  it("needs a thread id outside a thread, and rejects an unknown one", async () => {
    await withHost({}, async (host) => {
      expect((await host.run(["findings"])).exitCode).toBe(2);
      const missing = await host.run(["findings", "ghost"]);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toBe("Thread ghost not found or unavailable.\n");
    });
  });

  describe("--clear", () => {
    it("is refused inside a bb thread, even with an explicit id, and drops nothing", async () => {
      await withHost({}, async (host) => {
        await host.kv.set(`findings:${THREAD_ID}`, store);
        const result = await host.run(["findings", THREAD_ID, "--clear"], THREAD_ID);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("only allowed from a terminal outside a bb thread");
        expect(await host.kv.get(`findings:${THREAD_ID}`)).toEqual(store);
      });
    });

    it("needs an explicit thread id", async () => {
      await withHost({}, async (host) => {
        await host.kv.set(`findings:${THREAD_ID}`, store);
        const result = await host.run(["findings", "--clear"]);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("needs an explicit thread id");
        expect(await host.kv.get(`findings:${THREAD_ID}`)).toEqual(store);
      });
    });

    it("drops the chains and keeps the last report and incidents", async () => {
      await withHost({}, async (host) => {
        await host.kv.set(`findings:${THREAD_ID}`, store);
        const result = await host.run(["findings", THREAD_ID, "--clear"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(`Cleared 3 finding(s) for ${THREAD_ID}.\n`);
        expect(await host.kv.get(`findings:${THREAD_ID}`)).toEqual({ ...store, chains: {} });
      });
    });

    it("logs what it cleared", async () => {
      await withHost({}, async (host) => {
        await host.kv.set(`findings:${THREAD_ID}`, store);
        await host.run(["findings", THREAD_ID, "--clear"]);
        expect(
          host.harness.logEntries
            .filter((entry) => entry.level === "info")
            .map((entry) => entry.message),
        ).toContain(`findings for thread ${THREAD_ID}: cleared 3 chain(s) (via terminal)`);
      });
    });

    it("does not swallow the thread id that follows it", async () => {
      await withHost({}, async (host) => {
        await host.kv.set(`findings:${THREAD_ID}`, store);
        const result = await host.run(["findings", "--clear", THREAD_ID, "--json"]);
        expect(parse(result.stdout)).toMatchObject({ ok: true, cleared: 3, threadId: THREAD_ID });
      });
    });
  });
});

describe("auto-review cli: status — review result", () => {
  const report = {
    reviewId: 1,
    at: Date.UTC(2026, 0, 2, 3, 4, 5),
    outcome: "merged",
    summary: "shipped",
    counts: { open: 0, fixed: 0, falsePositive: 0 },
  };
  const open = (key: string, reRaised: boolean) => ({
    key,
    title: key,
    file: "a.ts",
    severity: "low",
    status: "open",
    firstSeenAt: 1,
    lastSeenAt: 1,
    raisedCount: 1,
    dismissCount: 0,
    reRaised,
    lastReviewId: 1,
  });

  it("prints the outcome, its time, the open counts and the last incident", async () => {
    await withHost({}, async (host) => {
      await host.kv.set(`findings:${THREAD_ID}`, {
        chains: { a: open("a", true), b: open("b", false) },
        lastReport: report,
        incidents: [{ at: Date.UTC(2026, 0, 3), kind: "send-failed", detail: "boom" }],
      });
      const text = (await host.run(["status"], THREAD_ID)).stdout ?? "";
      expect(text).toContain("reviewResult: merged at 2026-01-02T03:04:05.000Z (2 open, 1 re-raised)\n");
      expect(text).toContain("lastIncident: send-failed at 2026-01-03T00:00:00.000Z: boom\n");
    });
  });

  it("adds the same to --json", async () => {
    await withHost({}, async (host) => {
      await host.kv.set(`findings:${THREAD_ID}`, {
        chains: { a: open("a", true) },
        lastReport: report,
        incidents: [{ at: 7, kind: "not-reported", detail: "x" }],
      });
      expect(parse(((await host.run(["status", "--json"], THREAD_ID)).stdout))).toMatchObject({
        reviewResult: { status: "merged", at: report.at, summary: "shipped" },
        openFindings: 1,
        reRaisedFindings: 1,
        lastIncident: { at: 7, kind: "not-reported", detail: "x" },
      });
    });
  });

  it.each(["pending-dispatch", "awaiting-review"])("reports pending while the phase is %s", async (phase) => {
    await withHost({}, async (host) => {
      await host.kv.set(`findings:${THREAD_ID}`, { chains: {}, lastReport: report, incidents: [] });
      host.metadataFor(THREAD_ID).phase = phase;
      // The last report's time belongs to the previous review, so none is shown.
      expect((await host.run(["status"], THREAD_ID)).stdout).toContain("reviewResult: pending (0 open, 0 re-raised)\n");
      expect(parse(((await host.run(["status", "--json"], THREAD_ID)).stdout))).toMatchObject({
        reviewResult: { status: "pending", at: null },
      });
    });
  });

  it("does not count recent false positives as open findings left out of the prompt", async () => {
    await withHost({}, async (host) => {
      const chains = Object.fromEntries([
        ...["a", "b", "c"].map((key) => [key, open(key, false)]),
        ...Array.from({ length: MAX_PROMPT_FINDINGS + 5 }, (_, index) => [
          `fp${index}`,
          { ...open(`fp${index}`, false), status: "false-positive", lastSeenAt: Date.now() },
        ]),
      ]);
      await host.kv.set(`findings:${THREAD_ID}`, { chains, lastReport: report, incidents: [] });
      const text = (await host.run(["status"], THREAD_ID)).stdout ?? "";
      expect(text).toContain("(3 open, 0 re-raised)\n");
      expect(text).not.toContain("not listed");
      expect(parse((await host.run(["findings", "--json"], THREAD_ID)).stdout)).toMatchObject({ omittedFromPrompt: 0 });
      expect((await host.run(["findings"], THREAD_ID)).stdout).not.toContain("not listed");
    });
  });

  it("says how many open findings the next review's prompt cannot list", async () => {
    await withHost({}, async (host) => {
      const chains = Object.fromEntries(
        Array.from({ length: MAX_PROMPT_FINDINGS + 2 }, (_, index) => [`k${index}`, open(`k${index}`, false)]),
      );
      await host.kv.set(`findings:${THREAD_ID}`, { chains, lastReport: report, incidents: [] });
      expect((await host.run(["status"], THREAD_ID)).stdout).toContain(
        `reviewResult: merged at 2026-01-02T03:04:05.000Z (${MAX_PROMPT_FINDINGS + 2} open — 2 not listed in the next review's prompt, 0 re-raised)\n`,
      );
      expect(parse(((await host.run(["status", "--json"], THREAD_ID)).stdout))).toMatchObject({
        openFindings: MAX_PROMPT_FINDINGS + 2,
        omittedFromPrompt: 2,
      });
    });
  });
});
