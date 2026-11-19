// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, test } from "vitest";

import type { Snapshot, Stage, Task } from "@/lib/triage-types";

installTestPluginRuntime();

// The store captures the host's plugin-sdk/app bindings at import time, so the
// component must load after the test runtime is installed.
const { TriageThreadsSection } = await import("@/components/triage/thread-context-section");

afterEach(cleanup);

const MINUTE = 60_000;
const NOW = Date.now();

const STAGES: Stage[] = [
  { id: "s-todo", name: "To Do", position: 100, systemRole: "intake" },
  { id: "s-active", name: "In Progress", position: 200, systemRole: "active" },
  { id: "s-attention", name: "Human Review", position: 300, systemRole: "attention" },
  { id: "s-done", name: "Completed", position: 400, systemRole: "done" },
  { id: "s-custom", name: "Holding", position: 500, systemRole: null },
];

let counter = 0;
function card(overrides: Partial<Task> = {}): Task {
  counter += 1;
  return {
    id: `t-${counter}`,
    number: counter,
    title: `Card ${counter}`,
    description: "",
    stageId: "s-active",
    projectId: "p1",
    projectName: "Project One",
    machineId: "m1",
    machineName: "Machine One",
    branchName: "main",
    providerId: "claude-code",
    model: "test-model",
    reasoningLevel: "none",
    request: null,
    scheduledAt: null,
    threadId: `thr-${counter}`,
    sidebarVisible: null,
    runState: "idle",
    attentionReason: null,
    readAt: null,
    settledAt: null,
    createdAt: NOW - 60 * MINUTE,
    updatedAt: NOW - 5 * MINUTE,
    ...overrides,
  } as Task;
}

function snapshotOf(tasks: Task[], stages: Stage[] = STAGES): Snapshot {
  return { stages, tasks, projects: [], machines: [], notifications: [], unreadCount: 0 } as Snapshot;
}

const THREAD_PROPS = { threadId: "thr-host", projectId: "p1", environment: null } as never;

async function mount(snapshot: Snapshot) {
  const view = renderSlot({ component: TriageThreadsSection } as never, THREAD_PROPS, {
    rpc: { snapshot: () => snapshot } as never,
  });
  await waitFor(() => expect(view.rpcCalls.length).toBeGreaterThan(0));
  await act(async () => {});
  return view;
}

const headings = () => screen.queryAllByRole("heading", { level: 4 }).map((node) => node.textContent);

function group(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { level: 4, name });
  return heading.parentElement as HTMLElement;
}

const rowTexts = (name: string) =>
  within(group(name)).getAllByRole("listitem").map((node) => node.textContent ?? "");

// Runs first: the store module starts pristine here, and a failed first load
// is the only way to reach the "no snapshot yet" state without a hung fetch.
test("renders nothing while no snapshot has loaded", async () => {
  const view = renderSlot({ component: TriageThreadsSection } as never, THREAD_PROPS, {
    rpc: {
      snapshot: () => {
        throw new Error("offline");
      },
    } as never,
  });
  await waitFor(() => expect(view.rpcCalls.length).toBeGreaterThan(0));
  await act(async () => {});
  expect(view.container.childElementCount).toBe(0);
});

describe("groups", () => {
  test("render in the order active, attention, done, titled with the stage names", async () => {
    await mount(snapshotOf([
      card({ title: "Done one", stageId: "s-done" }),
      card({ title: "Review one", stageId: "s-attention" }),
      card({ title: "Active one", stageId: "s-active" }),
    ]));
    expect(headings()).toStrictEqual(["In Progress", "Human Review", "Completed"]);
  });

  test("follow the stage role, not the stage position, and use renamed stage names", async () => {
    const renamed: Stage[] = [
      { id: "s-done", name: "Shipped", position: 1, systemRole: "done" },
      { id: "s-attention", name: "Needs eyes", position: 2, systemRole: "attention" },
      { id: "s-active", name: "Doing", position: 3, systemRole: "active" },
    ];
    await mount(snapshotOf([
      card({ stageId: "s-done" }),
      card({ stageId: "s-attention" }),
      card({ stageId: "s-active" }),
    ], renamed));
    expect(headings()).toStrictEqual(["Doing", "Needs eyes", "Shipped"]);
    expect(screen.queryByRole("heading", { level: 4, name: "In Progress" })).toBeNull();
  });

  test("a group without cards is not rendered while the others are", async () => {
    await mount(snapshotOf([card({ title: "Only active", stageId: "s-active" })]));
    expect(headings()).toStrictEqual(["In Progress"]);
  });

  test("a role whose stage is missing is skipped and the others still render", async () => {
    await mount(snapshotOf(
      [card({ stageId: "s-active" }), card({ stageId: "s-done" })],
      STAGES.filter((stage) => stage.systemRole !== "attention"),
    ));
    expect(headings()).toStrictEqual(["In Progress", "Completed"]);
  });

  test("cards in intake and custom stages are not listed", async () => {
    await mount(snapshotOf([
      card({ title: "Visible", stageId: "s-active" }),
      card({ title: "Intake card", stageId: "s-todo" }),
      card({ title: "Custom card", stageId: "s-custom" }),
    ]));
    expect(screen.getByText(/Visible/)).toBeTruthy();
    expect(screen.queryByText(/Intake card/)).toBeNull();
    expect(screen.queryByText(/Custom card/)).toBeNull();
  });

  test("render nothing when every group is empty", async () => {
    const view = await mount(snapshotOf([card({ stageId: "s-todo" }), card({ stageId: "s-active", threadId: null })]));
    expect(view.container.childElementCount).toBe(0);
  });

  test("render nothing when there are no cards", async () => {
    const view = await mount(snapshotOf([]));
    expect(view.container.childElementCount).toBe(0);
  });
});

describe("filters", () => {
  test("a failed card is visible in the active and attention stages", async () => {
    await mount(snapshotOf([
      card({ title: "Failed active", stageId: "s-active", runState: "failed" }),
      card({ title: "Failed review", stageId: "s-attention", runState: "failed" }),
    ]));
    expect(screen.getByText(/Failed active/)).toBeTruthy();
    expect(screen.getByText(/Failed review/)).toBeTruthy();
    expect(headings()).toStrictEqual(["In Progress", "Human Review"]);
  });

  test("a failed card that is settled is hidden in the attention stage", async () => {
    await mount(snapshotOf([
      card({ title: "Failed settled", stageId: "s-attention", runState: "failed", settledAt: 1 }),
      card({ title: "Calm review", stageId: "s-attention" }),
    ]));
    expect(screen.queryByText(/Failed settled/)).toBeNull();
    expect(screen.getByText(/Calm review/)).toBeTruthy();
  });

  test("a failed card in the done stage is hidden", async () => {
    await mount(snapshotOf([
      card({ title: "Failed done", stageId: "s-done", runState: "failed" }),
      card({ title: "Fine done", stageId: "s-done" }),
    ]));
    expect(screen.queryByText(/Failed done/)).toBeNull();
    expect(screen.getByText(/Fine done/)).toBeTruthy();
  });

  test("settled cards are hidden in every sidebar group", async () => {
    await mount(snapshotOf([
      card({ title: "Settled active", stageId: "s-active", settledAt: 1 }),
      card({ title: "Open active", stageId: "s-active" }),
      card({ title: "Settled review", stageId: "s-attention", settledAt: 1 }),
      card({ title: "Open review", stageId: "s-attention" }),
      card({ title: "Settled done", stageId: "s-done", settledAt: 1 }),
      card({ title: "Unsettled done", stageId: "s-done" }),
    ]));
    expect(screen.queryByText(/Settled active/)).toBeNull();
    expect(screen.queryByText(/Settled review/)).toBeNull();
    expect(screen.getByText(/Open active/)).toBeTruthy();
    expect(screen.getByText(/Open review/)).toBeTruthy();
    expect(screen.queryByText(/Settled done/)).toBeNull();
    expect(screen.getByText(/Unsettled done/)).toBeTruthy();
  });

  test("a card without a thread is hidden and one with a thread is shown", async () => {
    await mount(snapshotOf([
      card({ title: "No thread", stageId: "s-active", threadId: null }),
      card({ title: "Has thread", stageId: "s-active" }),
    ]));
    expect(screen.queryByText(/No thread/)).toBeNull();
    expect(screen.getByText(/Has thread/)).toBeTruthy();
  });

  test("a completed group with only settled cards is hidden", async () => {
    await mount(snapshotOf([
      card({ title: "Settled completion", stageId: "s-done", settledAt: 1 }),
      card({ title: "Visible active", stageId: "s-active" }),
    ]));
    expect(screen.getByText(/Visible active/)).toBeTruthy();
    expect(screen.queryByText(/Settled completion/)).toBeNull();
    expect(screen.queryByRole("heading", { level: 4, name: "Completed" })).toBeNull();
  });

  test("done lists all eligible cards newest first, read or not", async () => {
    const done = Array.from({ length: 12 }, (_, index) => card({
      title: `Done ${index}`,
      stageId: "s-done",
      readAt: index % 2 === 0 ? 1 : null,
      updatedAt: NOW - (index + 1) * MINUTE,
    }));
    const settled = Array.from({ length: 11 }, (_, index) => card({
      title: `Settled ${index}`,
      stageId: "s-done",
      settledAt: 1,
      updatedAt: NOW + (index + 1) * MINUTE,
    }));
    await mount(snapshotOf([...done].reverse().concat(settled)));
    const texts = rowTexts("Completed");
    expect(texts).toHaveLength(12);
    for (let index = 0; index < 12; index += 1) expect(texts[index]).toContain(`Done ${index}`);
    expect(screen.queryByText(/Settled/)).toBeNull();
  });
});

describe("rows", () => {
  test("sort by updatedAt, newest first, within each group", async () => {
    await mount(snapshotOf([
      card({ title: "Middle", stageId: "s-active", updatedAt: NOW - 20 * MINUTE }),
      card({ title: "Newest", stageId: "s-active", updatedAt: NOW - 1 * MINUTE }),
      card({ title: "Oldest", stageId: "s-active", updatedAt: NOW - 90 * MINUTE }),
    ]));
    const texts = rowTexts("In Progress");
    expect(texts[0]).toContain("Newest");
    expect(texts[1]).toContain("Middle");
    expect(texts[2]).toContain("Oldest");
  });

  test("show every task in each category without collapsing", async () => {
    await mount(snapshotOf([
      ...Array.from({ length: 6 }, () => card({ stageId: "s-active" })),
      ...Array.from({ length: 6 }, () => card({ stageId: "s-attention" })),
      ...Array.from({ length: 12 }, () => card({ stageId: "s-done" })),
    ]));
    for (const [name, count] of [["In Progress", 6], ["Human Review", 6], ["Completed", 12]] as const) {
      const list = within(group(name)).getByRole("list");
      expect(within(list).getAllByRole("listitem")).toHaveLength(count);
      expect(list.getAttribute("data-limit")).toBe(String(count));
    }
  });

  test("show the number, title, tooltip with the project, and the short age", async () => {
    const target = card({ title: "Wire the card", stageId: "s-active", projectName: "Acme", updatedAt: NOW - 5 * MINUTE });
    await mount(snapshotOf([target]));
    const row = screen.getByTestId("bb-thread-context-card-row");
    expect(row.textContent).toContain(`#${target.number} Wire the card`);
    expect(row.textContent).toContain("5m");
    expect(row.getAttribute("title")).toBe(`#${target.number} Wire the card · Acme`);
  });

  test("render titles as plain text", async () => {
    await mount(snapshotOf([card({ title: "<b>bold</b> **star**", stageId: "s-active" })]));
    const row = screen.getByTestId("bb-thread-context-card-row");
    expect(row.textContent).toContain("<b>bold</b> **star**");
    expect(row.querySelector("b")).toBeNull();
  });

  test("a click opens that card's thread", async () => {
    const first = card({ title: "First", stageId: "s-active", updatedAt: NOW - 1 * MINUTE });
    const second = card({ title: "Second", stageId: "s-active", updatedAt: NOW - 9 * MINUTE });
    const view = await mount(snapshotOf([first, second]));
    expect(view.navigateCalls).toStrictEqual([]);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`#${second.number} Second`) }));
    expect(view.navigateCalls).toStrictEqual([{ method: "toThread", threadId: second.threadId }]);
  });
});

describe("status dot", () => {
  const dots = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>("[data-tone]"));

  test("a running card pulses and announces its run state", async () => {
    const view = await mount(snapshotOf([card({ stageId: "s-active", runState: "working" })]));
    const dot = screen.getByRole("img", { name: "Working" });
    expect(dot.hasAttribute("data-pulse")).toBe(true);
    expect(dot.getAttribute("data-tone")).toBe("ongoing");
    expect(dots(view.container)).toHaveLength(1);
  });

  test("a failed card announces its state without pulsing", async () => {
    await mount(snapshotOf([card({ stageId: "s-attention", runState: "failed" })]));
    const dot = screen.getByRole("img", { name: "Failed" });
    expect(dot.hasAttribute("data-pulse")).toBe(false);
  });

  test("an idle card neither pulses nor announces anything", async () => {
    const view = await mount(snapshotOf([card({ stageId: "s-attention", runState: "idle" })]));
    expect(screen.queryByRole("img")).toBeNull();
    const [dot] = dots(view.container);
    expect(dot?.hasAttribute("data-pulse")).toBe(false);
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.getAttribute("data-tone")).toBe("danger");
  });
});

describe("realtime", () => {
  test("a settled completion disappears after a fresh snapshot", async () => {
    const done = card({ title: "Fresh completion", stageId: "s-done" });
    const snapshot = snapshotOf([done]);
    const view = await mount(snapshot);
    expect(screen.getByText(/Fresh completion/)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Completed" })).toBeTruthy();

    snapshot.tasks = [{ ...done, settledAt: 1 }];
    const before = view.rpcCalls.length;
    await view.emitRealtime("triage", { at: 910_004 });
    await waitFor(() => expect(view.rpcCalls.length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByText(/Fresh completion/)).toBeNull());
    expect(screen.queryByRole("heading", { level: 4, name: "Completed" })).toBeNull();
  });

  test("a fresh stamp refreshes the snapshot and the same stamp does not repeat it", async () => {
    const view = await mount(snapshotOf([card({ stageId: "s-active" })]));
    const before = view.rpcCalls.length;
    await view.emitRealtime("triage", { at: 910_001 });
    await waitFor(() => expect(view.rpcCalls.length).toBeGreaterThan(before));
    const after = view.rpcCalls.length;
    await view.emitRealtime("triage", { at: 910_001 });
    await act(async () => {});
    expect(view.rpcCalls.length).toBe(after);
  });

  test("a different stamp refreshes again", async () => {
    const view = await mount(snapshotOf([card({ stageId: "s-active" })]));
    await view.emitRealtime("triage", { at: 910_002 });
    await act(async () => {});
    const claimed = view.rpcCalls.length;
    await view.emitRealtime("triage", { at: 910_003 });
    await waitFor(() => expect(view.rpcCalls.length).toBeGreaterThan(claimed));
  });
});
