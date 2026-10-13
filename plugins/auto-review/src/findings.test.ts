import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  emptyStore,
  findingsKey,
  FALSE_POSITIVE_PROMPT_WINDOW_MS,
  isThreadNotFound,
  MAX_CHAINS,
  MAX_INCIDENTS,
  MAX_PROMPT_FINDINGS,
  mergeReport,
  openFindingsForPrompt,
  readFindings,
  recordUnreported,
  reportedFindingSchema,
  reviewReportSchema,
  summarizeReview,
  withUnreportedOutcome,
  writeFindings,
  type FindingsStore,
  type ReportedFinding,
  type ReviewReport,
} from "./findings.js";

const T0 = 1_000_000;

function finding(overrides: Partial<ReportedFinding> = {}): ReportedFinding {
  return {
    key: "null-deref",
    title: "Null dereference",
    file: "src/a.ts",
    line: 10,
    severity: "medium",
    status: "open",
    ...overrides,
  };
}

function report(findings: ReportedFinding[], overrides: Partial<ReviewReport> = {}): ReviewReport {
  return { outcome: "committed", summary: "done", findings, ...overrides };
}

/** Applies reports as reviews 1, 2, 3, … at one-minute steps. */
function run(...reports: ReviewReport[]): FindingsStore {
  let store = emptyStore();
  reports.forEach((entry, index) => {
    store = mergeReport(store, entry, index + 1, T0 + index * 60_000).store;
  });
  return store;
}

describe("mergeReport: chain creation", () => {
  it("starts a chain with counts for each first status", () => {
    const store = run(
      report([
        finding({ key: "a" }),
        finding({ key: "b", status: "fixed" }),
        finding({ key: "c", status: "false-positive", reason: "guarded upstream" }),
      ]),
    );
    expect(store.chains.a).toMatchObject({ status: "open", raisedCount: 1, dismissCount: 0, reRaised: false });
    expect(store.chains.b).toMatchObject({ status: "fixed", raisedCount: 0, dismissCount: 0 });
    expect(store.chains.c).toMatchObject({
      status: "false-positive",
      raisedCount: 1,
      dismissCount: 1,
      dismissReason: "guarded upstream",
    });
    expect(store.chains.a).toMatchObject({ firstSeenAt: T0, lastSeenAt: T0, lastReviewId: 1 });
  });

  it("records the report and its own counts", () => {
    const store = run(
      report([finding({ key: "a" }), finding({ key: "b", status: "fixed" })], {
        outcome: "merged",
        summary: "ok",
      }),
    );
    expect(store.lastReport).toEqual({
      reviewId: 1,
      at: T0,
      outcome: "merged",
      summary: "ok",
      counts: { open: 1, fixed: 1, falsePositive: 0 },
    });
  });

  it("keeps the maximum severity ever seen", () => {
    const store = run(
      report([finding({ severity: "high" })]),
      report([finding({ severity: "low" })]),
    );
    expect(store.chains["null-deref"]?.severity).toBe("high");
    const raised = run(
      report([finding({ severity: "low" })]),
      report([finding({ severity: "blocker" })]),
    );
    expect(raised.chains["null-deref"]?.severity).toBe("blocker");
  });

  it("takes the later entry when one report repeats a key", () => {
    const store = run(report([finding({ title: "first" }), finding({ title: "second" })]));
    expect(store.chains["null-deref"]).toMatchObject({ title: "second", raisedCount: 1 });
  });
});

describe("mergeReport: re-raise", () => {
  it("marks a finding reported open after it was fixed as re-raised", () => {
    const store = run(
      report([finding()]),
      report([finding({ status: "fixed" })]),
      report([finding()]),
    );
    expect(store.chains["null-deref"]).toMatchObject({ status: "open", reRaised: true, raisedCount: 2 });
  });

  it("does not raise a chain a report marks fixed", () => {
    const store = run(report([finding()]), report([finding({ status: "fixed" })]));
    expect(store.chains["null-deref"]).toMatchObject({ status: "fixed", raisedCount: 1 });
  });

  it("marks an open finding dismissed earlier as re-raised", () => {
    const store = run(
      report([finding({ status: "false-positive", reason: "dead code" })]),
      report([finding()]),
    );
    expect(store.chains["null-deref"]).toMatchObject({ status: "open", reRaised: true });
  });

  it("clears the re-raise once a later report marks the chain fixed", () => {
    const store = run(
      report([finding()]),
      report([finding({ status: "fixed" })]),
      report([finding()]),
      report([finding({ status: "fixed" })]),
    );
    expect(store.chains["null-deref"]).toMatchObject({ status: "fixed", reRaised: false });
  });

  it("clears the re-raise on a dismissal with a new reason", () => {
    const store = run(
      report([finding({ status: "false-positive", reason: "dead code" })]),
      report([finding()]),
      report([finding({ status: "false-positive", reason: "covered by a test" })]),
    );
    expect(store.chains["null-deref"]).toMatchObject({
      status: "false-positive",
      reRaised: false,
      dismissCount: 2,
    });
  });

  it("keeps a re-raised chain open when it is re-dismissed with the old reason", () => {
    const { store, ignored } = (() => {
      const before = run(
        report([finding({ status: "false-positive", reason: "Dead code" })]),
        report([finding()]),
      );
      return mergeReport(
        before,
        report([finding({ status: "false-positive", reason: " dead code " })]),
        3,
        T0 + 120_000,
      );
    })();
    expect(ignored.map((entry) => entry.key)).toEqual(["null-deref"]);
    expect(store.chains["null-deref"]).toMatchObject({ status: "open", reRaised: true, dismissCount: 1 });
  });
});

describe("mergeReport: re-dismissal", () => {
  const dismissed = report([finding({ status: "false-positive", reason: "Guarded upstream" })]);

  it("accepts a second dismissal with a different reason", () => {
    const before = run(dismissed);
    const merged = mergeReport(
      before,
      report([finding({ status: "false-positive", reason: "unreachable in prod" })]),
      2,
      T0 + 60_000,
    );
    expect(merged.ignored).toEqual([]);
    expect(merged.store.chains["null-deref"]).toMatchObject({
      dismissCount: 2,
      reason: "unreachable in prod",
      dismissReason: "unreachable in prod",
    });
  });

  it("ignores a second dismissal with the same reason, ignoring case and spacing", () => {
    const before = run(dismissed);
    const merged = mergeReport(
      before,
      report([finding({ status: "false-positive", reason: "  guarded UPSTREAM " })], { outcome: "blocked" }),
      2,
      T0 + 60_000,
    );
    expect(merged.ignored).toHaveLength(1);
    expect(merged.store.chains["null-deref"]).toEqual(before.chains["null-deref"]);
    // The outcome is never lost to an ignored finding.
    expect(merged.store.lastReport).toMatchObject({ reviewId: 2, outcome: "blocked" });
  });

  it("ignores a second dismissal with no reason", () => {
    const before = run(dismissed);
    const merged = mergeReport(
      before,
      report([{ ...finding({ status: "false-positive" }), reason: undefined }]),
      2,
      T0 + 60_000,
    );
    expect(merged.ignored).toHaveLength(1);
    expect(merged.store.chains["null-deref"]).toEqual(before.chains["null-deref"]);
  });

  it("leaves a dismissed chain the next report omits unchanged", () => {
    const before = run(dismissed);
    const merged = mergeReport(before, report([finding({ key: "other" })]), 2, T0 + 60_000);
    expect(merged.store.chains["null-deref"]).toEqual(before.chains["null-deref"]);
  });
});

describe("mergeReport: one review, many reports", () => {
  it("replaces the earlier report instead of stacking on it", () => {
    const first = report([finding()]);
    const store1 = mergeReport(run(report([finding({ status: "fixed" })])), first, 2, T0 + 60_000).store;
    // Same review (id 2) reports again.
    const store2 = mergeReport(store1, first, 2, T0 + 120_000).store;
    expect(store2.chains["null-deref"]).toMatchObject({ status: "open", raisedCount: 1, reRaised: true });
    expect(store2.chains["null-deref"]?.raisedCount).toBe(store1.chains["null-deref"]?.raisedCount);
  });

  it("does not count fixed-then-open inside one review as a re-raise", () => {
    const store1 = mergeReport(emptyStore(), report([finding({ status: "fixed" })]), 1, T0).store;
    const store2 = mergeReport(store1, report([finding()]), 1, T0 + 1).store;
    expect(store2.chains["null-deref"]).toMatchObject({ status: "open", reRaised: false, raisedCount: 1 });
  });

  it("drops a chain only an earlier report of the review created", () => {
    const store1 = mergeReport(emptyStore(), report([finding({ key: "a" }), finding({ key: "b" })]), 1, T0).store;
    const store2 = mergeReport(store1, report([finding({ key: "a" })]), 1, T0 + 1).store;
    expect(Object.keys(store2.chains)).toEqual(["a"]);
  });

  it("restores a chain only an earlier report of the review touched", () => {
    const base = run(report([finding({ key: "a", severity: "low" })]));
    const touched = mergeReport(
      base,
      report([finding({ key: "a", severity: "blocker", status: "fixed" })]),
      2,
      T0 + 60_000,
    ).store;
    expect(touched.chains.a).toMatchObject({ severity: "blocker", status: "fixed" });
    const replaced = mergeReport(touched, report([finding({ key: "b" })]), 2, T0 + 120_000).store;
    expect(replaced.chains.a).toEqual(base.chains.a);
    expect(replaced.chains.b).toBeDefined();
  });

  it("restores a dismissal reason (to none) when a later report of the review omits the chain", () => {
    const base = run(report([finding()]));
    const dismissed = mergeReport(
      base,
      report([finding({ status: "false-positive", reason: "guarded upstream" })]),
      2,
      T0 + 60_000,
    ).store;
    expect(dismissed.chains["null-deref"]).toMatchObject({ dismissCount: 1, dismissReason: "guarded upstream" });
    // The store is persisted as JSON between the two reports of the review.
    const stored = JSON.parse(JSON.stringify(dismissed)) as FindingsStore;
    const replaced = mergeReport(stored, report([finding({ key: "other" })]), 2, T0 + 120_000).store;
    expect(replaced.chains["null-deref"]).toMatchObject({ status: "open", dismissCount: 0 });
    expect(replaced.chains["null-deref"]?.dismissReason).toBeUndefined();

    // So a later legitimate dismissal with the same reason is accepted, not ignored.
    const later = mergeReport(
      replaced,
      report([finding({ status: "false-positive", reason: "guarded upstream" })]),
      3,
      T0 + 180_000,
    );
    expect(later.ignored).toEqual([]);
    expect(later.store.chains["null-deref"]).toMatchObject({ status: "false-positive", dismissCount: 1 });
  });

  it("restores a previous dismissal reason, not the reviewed one", () => {
    const first = run(report([finding({ status: "false-positive", reason: "dead code" })]));
    const second = mergeReport(
      first,
      report([finding({ status: "false-positive", reason: "covered by a test" })]),
      2,
      T0 + 60_000,
    ).store;
    const stored = JSON.parse(JSON.stringify(second)) as FindingsStore;
    const replaced = mergeReport(stored, report([]), 2, T0 + 120_000).store;
    expect(replaced.chains["null-deref"]).toMatchObject({
      dismissCount: 1,
      reason: "dead code",
      dismissReason: "dead code",
    });
  });

  it("replaces lastReport", () => {
    const store1 = mergeReport(emptyStore(), report([], { outcome: "blocked", summary: "first" }), 1, T0).store;
    const store2 = mergeReport(store1, report([], { outcome: "merged", summary: "second" }), 1, T0 + 1).store;
    expect(store2.lastReport).toMatchObject({ outcome: "merged", summary: "second" });
  });
});

describe("mergeReport: eviction", () => {
  function crowded(settled: "fixed" | "false-positive" = "fixed"): FindingsStore {
    const chains: FindingsStore["chains"] = {};
    for (let index = 0; index < MAX_CHAINS; index += 1) {
      const key = `old-${index}`;
      const status = index % 2 === 0 ? "open" : settled;
      chains[key] = {
        key,
        title: key,
        file: "src/a.ts",
        severity: "low",
        status,
        reason: status === "false-positive" ? "r" : undefined,
        firstSeenAt: T0 + index,
        lastSeenAt: T0 + index,
        raisedCount: 1,
        dismissCount: status === "false-positive" ? 1 : 0,
        reRaised: false,
        lastReviewId: 0,
      };
    }
    return { chains, incidents: [] };
  }

  it("evicts the oldest settled chains before any open one", () => {
    const merged = mergeReport(crowded(), report([finding({ key: "new-1" }), finding({ key: "new-2" })]), 1, T0 + 10_000);
    const keys = Object.keys(merged.store.chains);
    expect(keys).toHaveLength(MAX_CHAINS);
    // old-1 and old-3 are the two oldest settled chains.
    expect(keys).not.toContain("old-1");
    expect(keys).not.toContain("old-3");
    expect(keys).toContain("old-0");
    expect(keys).toContain("new-1");
  });

  it("evicts the oldest open chains only once no settled one is left", () => {
    const store = crowded();
    for (const chain of Object.values(store.chains)) {
      chain.status = "open";
    }
    const merged = mergeReport(store, report([finding({ key: "new-1" })]), 1, T0 + 10_000);
    const keys = Object.keys(merged.store.chains);
    expect(keys).not.toContain("old-0");
    expect(keys).toContain("old-1");
  });

  it("never evicts a chain the report touched, even an old settled one", () => {
    const merged = mergeReport(
      crowded(),
      report([finding({ key: "old-1", status: "fixed" }), finding({ key: "new-1" })]),
      1,
      T0 + 10_000,
    );
    expect(Object.keys(merged.store.chains)).toContain("old-1");
    expect(Object.keys(merged.store.chains)).toHaveLength(MAX_CHAINS);
  });
});

describe("report schema", () => {
  const valid = {
    key: "a.b:c/d-1",
    title: "A title",
    file: "src/a.ts",
    severity: "high",
    status: "open",
  };

  it("strips control, format and separator characters from every free-text field", () => {
    const dirty = "x\u0000y\nz‮w​v\u0085u";
    const parsed = reviewReportSchema.parse({
      outcome: "committed",
      summary: dirty,
      findings: [{ ...valid, title: dirty, reason: dirty }],
    });
    expect(parsed.summary).toBe("xyzwvu");
    expect(parsed.findings[0]).toMatchObject({ title: "xyzwvu", reason: "xyzwvu" });
  });

  it("rejects a bad key, an unsafe path, an unknown severity and an agent-set plugin outcome", () => {
    expect(reportedFindingSchema.safeParse({ ...valid, key: "Bad Key" }).success).toBe(false);
    expect(reportedFindingSchema.safeParse({ ...valid, key: "-lead" }).success).toBe(false);
    expect(reportedFindingSchema.safeParse({ ...valid, file: "src/a b.ts" }).success).toBe(false);
    expect(reportedFindingSchema.safeParse({ ...valid, file: "../`rm`" }).success).toBe(false);
    expect(reportedFindingSchema.safeParse({ ...valid, severity: "critical" }).success).toBe(false);
    expect(reviewReportSchema.safeParse({ outcome: "not-reported", summary: "x" }).success).toBe(false);
  });

  it("requires a reason for a false positive", () => {
    expect(reportedFindingSchema.safeParse({ ...valid, status: "false-positive" }).success).toBe(false);
    expect(
      reportedFindingSchema.safeParse({ ...valid, status: "false-positive", reason: "​  " }).success,
    ).toBe(false);
    expect(
      reportedFindingSchema.safeParse({ ...valid, status: "false-positive", reason: "guarded" }).success,
    ).toBe(true);
  });

  it("caps the lengths and the number of findings", () => {
    expect(reportedFindingSchema.safeParse({ ...valid, title: "x".repeat(201) }).success).toBe(false);
    expect(reportedFindingSchema.safeParse({ ...valid, reason: "x".repeat(301) }).success).toBe(false);
    expect(reviewReportSchema.safeParse({ outcome: "merged", summary: "x".repeat(501) }).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, index) => ({ ...valid, key: `k${index}` }));
    expect(reviewReportSchema.safeParse({ outcome: "merged", summary: "", findings: many }).success).toBe(false);
  });

  it("defaults findings to none", () => {
    expect(reviewReportSchema.parse({ outcome: "no-changes", summary: "nothing" }).findings).toEqual([]);
  });
});

describe("openFindingsForPrompt", () => {
  it("lists re-raised chains first, then by severity, with recent false positives after the open ones", () => {
    const store = run(
      report([
        finding({ key: "low-open", severity: "low" }),
        finding({ key: "blocker-open", severity: "blocker" }),
        finding({ key: "fixed-one", status: "fixed" }),
        finding({ key: "fp", status: "false-positive", reason: "r" }),
        finding({ key: "reraised", severity: "low", status: "fixed" }),
      ]),
      report([finding({ key: "reraised", severity: "low" })]),
    );
    const { findings, omitted } = openFindingsForPrompt(store, T0 + 120_000);
    expect(findings.map((entry) => entry.key)).toEqual(["reraised", "blocker-open", "low-open", "fp"]);
    expect(omitted).toBe(0);
  });

  it("leaves out a false positive past the window", () => {
    const store = run(report([finding({ status: "false-positive", reason: "r" })]));
    expect(openFindingsForPrompt(store, T0 + FALSE_POSITIVE_PROMPT_WINDOW_MS).findings).toHaveLength(1);
    expect(openFindingsForPrompt(store, T0 + FALSE_POSITIVE_PROMPT_WINDOW_MS + 1).findings).toHaveLength(0);
  });

  it("caps the list and reports how many were omitted, re-raised first", () => {
    const many = Array.from({ length: 18 }, (_, index) => finding({ key: `k${index}`, severity: "high" }));
    const reRaised = [finding({ key: "back", severity: "low", status: "fixed" })];
    const store = run(report([...many, ...reRaised]), report([finding({ key: "back", severity: "low" })]));
    const { findings, omitted } = openFindingsForPrompt(store, T0 + 60_000);
    expect(findings).toHaveLength(MAX_PROMPT_FINDINGS);
    expect(findings[0]?.key).toBe("back");
    expect(omitted).toBe(19 - MAX_PROMPT_FINDINGS);
  });
});

describe("unreported outcomes", () => {
  it("records an outcome and an incident with cleaned, capped text", () => {
    const store = withUnreportedOutcome(
      emptyStore(),
      {
        reviewId: 5,
        outcome: "unavailable",
        summary: "could\nnot send",
        incident: { kind: "send-failed", detail: `bad\u0000${"x".repeat(400)}` },
      },
      T0,
    );
    expect(store.lastReport).toMatchObject({
      reviewId: 5,
      outcome: "unavailable",
      summary: "couldnot send",
      counts: { open: 0, fixed: 0, falsePositive: 0 },
    });
    expect(store.incidents).toHaveLength(1);
    expect(store.incidents[0]?.detail).toHaveLength(300);
    expect(store.incidents[0]?.detail.startsWith("bad")).toBe(true);
  });

  it("keeps the last twenty incidents and the chains", () => {
    let store = run(report([finding()]));
    for (let index = 0; index < MAX_INCIDENTS + 5; index += 1) {
      store = withUnreportedOutcome(
        store,
        { reviewId: 10 + index, outcome: "not-reported", summary: "s", incident: { kind: "not-reported", detail: `d${index}` } },
        T0 + index,
      );
    }
    expect(store.incidents).toHaveLength(MAX_INCIDENTS);
    expect(store.incidents.at(-1)?.detail).toBe(`d${MAX_INCIDENTS + 4}`);
    expect(Object.keys(store.chains)).toEqual(["null-deref"]);
  });
});

describe("summarizeReview", () => {
  it("is none without a store, pending while in flight, else the last outcome", () => {
    expect(summarizeReview(emptyStore(), false)).toEqual({
      status: "none",
      at: null,
      openCount: 0,
      reRaisedCount: 0,
      lastIncident: null,
    });
    const store = run(report([finding(), finding({ key: "b", status: "fixed" })]), report([finding({ key: "b" })]));
    expect(summarizeReview(store, true).status).toBe("pending");
    expect(summarizeReview(store, false)).toMatchObject({
      status: "committed",
      openCount: 2,
      reRaisedCount: 1,
    });
  });
});

describe("isThreadNotFound", () => {
  it("is true only for a definite not-found", () => {
    expect(isThreadNotFound(new Error("thread thr_1 not found"))).toBe(true);
    expect(isThreadNotFound({ status: 404 })).toBe(true);
    expect(isThreadNotFound({ code: "not_found" })).toBe(true);
    expect(isThreadNotFound(new Error("connection reset"))).toBe(false);
    expect(isThreadNotFound(new Error("timeout"))).toBe(false);
    expect(isThreadNotFound(null)).toBe(false);
  });
});

describe("findings store", () => {
  async function withHost(body: (host: ReturnType<typeof createFakePluginHost>) => Promise<void>) {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      await body(host);
    } finally {
      await host.harness.dispose();
    }
  }

  it("reads an empty store when none exists", async () => {
    await withHost(async (host) => {
      expect(await readFindings(host.bb, "thr_1")).toEqual(emptyStore());
    });
  });

  it("round-trips, and publishes to the thread's channel on every write", async () => {
    await withHost(async (host) => {
      const store = run(report([finding()]));
      await writeFindings(host.bb, "thr_1", store);
      expect(await readFindings(host.bb, "thr_1")).toEqual(store);
      expect(host.harness.realtimeSignals.map((signal) => signal.channel)).toEqual([
        "auto-review:thread:thr_1",
      ]);
    });
  });

  it("resets an unparseable store with a warning", async () => {
    await withHost(async (host) => {
      await host.bb.storage.kv.set(findingsKey("thr_1"), { chains: "nope" });
      expect(await readFindings(host.bb, "thr_1")).toEqual(emptyStore());
      expect(host.harness.logEntries.some((entry) => entry.level === "warn")).toBe(true);
    });
  });

  it("does not overwrite a report already recorded for the same review", async () => {
    await withHost(async (host) => {
      await writeFindings(host.bb, "thr_1", run(report([finding()], { outcome: "merged" })));
      await recordUnreported(host.bb, "thr_1", { reviewId: 1, outcome: "not-reported", summary: "s" });
      expect((await readFindings(host.bb, "thr_1")).lastReport?.outcome).toBe("merged");
      await recordUnreported(host.bb, "thr_1", { reviewId: 2, outcome: "stopped", summary: "s" });
      const after = await readFindings(host.bb, "thr_1");
      expect(after.lastReport).toMatchObject({ reviewId: 2, outcome: "stopped" });
      expect(Object.keys(after.chains)).toEqual(["null-deref"]);
    });
  });
});
