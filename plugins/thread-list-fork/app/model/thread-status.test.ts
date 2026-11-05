// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  experimental_resolveThreadStatus as sdkResolveThreadStatus,
  type PluginSidebarThreadRowStatus,
  type PluginThreadStatusInput,
} from "@get-bb/plugin-sdk/app";
import { makeSidebarThread, type SidebarThreadOverrides } from "./fixtures.js";
import { resolveSdkThreadStatus, resolveThreadStatus } from "./thread-status.js";

const thread = (overrides: SidebarThreadOverrides = {}) =>
  makeSidebarThread({ isUnread: false, ...overrides });

const rowStatus = (
  tone: PluginSidebarThreadRowStatus["tone"],
): PluginSidebarThreadRowStatus => ({
  icon: "Check",
  label: `Row ${tone ?? "neutral"}`,
  tone,
});

function resolve(
  overrides: Partial<PluginThreadStatusInput> = {},
): ReturnType<typeof resolveThreadStatus> {
  return resolveThreadStatus({
    thread: null,
    hiddenThreads: [],
    hasUnsubmittedDraft: false,
    rowStatus: null,
    ...overrides,
  });
}

// One thread per branch of the SDK resolver: every runtime and thread status,
// unread and read, top-level and child, each queued state, a pending
// interaction, and each activity counter.
const ARCHETYPES: readonly SidebarThreadOverrides[] = [
  {},
  { isUnread: true },
  { isUnread: true, status: "error" },
  { isUnread: true, status: "active" },
  { isUnread: true, status: "error", parentThreadId: "thr_parent" },
  { isUnread: true, parentThreadId: "thr_parent" },
  { runtimeStatus: "active" },
  { runtimeStatus: "provisioning" },
  { runtimeStatus: "starting" },
  { runtimeStatus: "stopping" },
  { runtimeStatus: "error" },
  { runtimeStatus: "waiting-for-host" },
  { queuedWork: "failed" },
  { queuedWork: "waiting" },
  { hasPendingInteraction: true },
  { activity: { workflows: 1 } },
  { activity: { backgroundAgents: 2 } },
  { activity: { backgroundCommands: 1 } },
  { activity: { planMode: 1 } },
  { activity: { goals: 1 } },
  { queuedWork: "waiting", runtimeStatus: "active", isUnread: true },
];

describe("resolveSdkThreadStatus", () => {
  it("matches the installed SDK resolver across the input space", () => {
    const threads = ARCHETYPES.map((overrides) => thread(overrides));
    const rows = [
      null,
      rowStatus(undefined),
      rowStatus("running"),
      rowStatus("success"),
    ];
    let compared = 0;
    for (const own of [null, ...threads]) {
      for (const hidden of [[], ...threads.map((item) => [item])]) {
        for (const hasUnsubmittedDraft of [false, true]) {
          for (const row of rows) {
            const input: PluginThreadStatusInput = {
              thread: own,
              hiddenThreads: hidden,
              hasUnsubmittedDraft,
              rowStatus: row,
            };
            expect(resolveSdkThreadStatus(input)).toEqual(
              sdkResolveThreadStatus(input),
            );
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(22 * 22 * 2 * 4);
  });

  it.each([
    [{ isUnread: true, status: "error" }, "unread-error", "Unread thread failed"],
    [{ hasPendingInteraction: true }, "waiting-for-input", "Thread needs user input"],
    [{ activity: { planMode: 1 } }, "plan-mode", "Plan mode active"],
    [{ runtimeStatus: "active" }, "runtime", "Thread working"],
    [{ queuedWork: "failed" }, "queued-failed", "Queued message failed to send"],
    [{ isUnread: true }, "unread-success", "Unread thread succeeded"],
    [{}, "none", null],
  ] as const)("resolves %j to %s", (overrides, indicator, label) => {
    const status = resolveSdkThreadStatus({
      thread: thread(overrides),
      hiddenThreads: [],
      hasUnsubmittedDraft: false,
      rowStatus: null,
    });
    expect(status).toMatchObject({ indicator, label });
  });

  it("counts a hidden child's attention and work, not its queued messages", () => {
    const status = resolveSdkThreadStatus({
      thread: null,
      hiddenThreads: [thread({ queuedWork: "failed" }), thread({ runtimeStatus: "active" })],
      hasUnsubmittedDraft: false,
      rowStatus: null,
    });
    expect(status).toMatchObject({ indicator: "runtime", isWorking: true });
  });

  it("keeps a row status below runtime, unread errors, and waiting for input", () => {
    const row = rowStatus("success");
    const shown = resolveSdkThreadStatus({
      thread: thread({ isUnread: true }),
      hiddenThreads: [],
      hasUnsubmittedDraft: false,
      rowStatus: row,
    });
    expect(shown).toMatchObject({ rowStatus: row, label: "Row success" });
    const hidden = resolveSdkThreadStatus({
      thread: thread({ hasPendingInteraction: true }),
      hiddenThreads: [],
      hasUnsubmittedDraft: false,
      rowStatus: row,
    });
    expect(hidden).toMatchObject({ rowStatus: null, label: "Thread needs user input" });
  });
});

describe("resolveThreadStatus", () => {
  const planApproval = thread({
    id: "thr_plan",
    hasPendingInteraction: true,
    indicator: "waiting-for-plan-approval",
  });
  const answer = thread({
    id: "thr_answer",
    hasPendingInteraction: true,
    indicator: "waiting-for-answer",
  });

  it.each([
    [planApproval, "waiting-for-plan-approval", "Thread needs plan approval"],
    [answer, "waiting-for-answer", "Thread is waiting for your answer"],
  ] as const)("shows %s as its own glyph", (pending, indicator, label) => {
    expect(resolve({ thread: pending })).toMatchObject({ indicator, label });
  });

  it("covers hidden children that wait on the same interaction", () => {
    expect(
      resolve({ hiddenThreads: [planApproval, { ...planApproval, id: "thr_b" }] }),
    ).toMatchObject({ indicator: "waiting-for-plan-approval" });
  });

  it("falls back to waiting for input when pending kinds differ or are unknown", () => {
    expect(resolve({ hiddenThreads: [planApproval, answer] })).toMatchObject({
      indicator: "waiting-for-input",
      label: "Thread needs user input",
    });
    expect(
      resolve({ hiddenThreads: [planApproval, thread({ hasPendingInteraction: true })] }),
    ).toMatchObject({ indicator: "waiting-for-input" });
  });

  it("ignores a fork indicator on a thread with nothing pending", () => {
    expect(
      resolve({ thread: thread({ indicator: "waiting-for-plan-approval" }) }),
    ).toMatchObject({ indicator: "none" });
  });

  it("does not replace a higher-priority indicator", () => {
    expect(
      resolve({
        thread: thread({
          isUnread: true,
          status: "error",
          hasPendingInteraction: true,
          indicator: "waiting-for-answer",
        }),
      }),
    ).toMatchObject({ indicator: "unread-error" });
  });

  it("drops the row status when a fork glyph shows", () => {
    expect(
      resolve({ thread: answer, rowStatus: rowStatus("success") }),
    ).toMatchObject({ indicator: "waiting-for-answer", rowStatus: null });
  });
});
