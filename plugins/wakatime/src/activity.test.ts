// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_INTERVAL_MS, NAVIGATION_GRACE_MS, trackActivity } from "./activity.js";
import type { ActivityRoute, ActivityTracker } from "./activity.js";

const ROUTE: ActivityRoute = { projectId: "prj_1", threadId: "thr_1" };

let focused: boolean;
let visibility: DocumentVisibilityState;
let clock: number;
let sent: ActivityRoute[];
let tracker: ActivityTracker;

function start(route: ActivityRoute = ROUTE) {
  tracker = trackActivity((r) => sent.push(r), route, () => clock);
}

beforeEach(() => {
  focused = true;
  visibility = "visible";
  clock = 1_000_000;
  sent = [];
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  tracker?.dispose();
  vi.restoreAllMocks();
});

describe("trackActivity", () => {
  it.each(["keydown", "pointerdown", "wheel"])("counts %s while focused and visible", (type) => {
    start();
    window.dispatchEvent(new Event(type));
    expect(sent).toEqual([ROUTE]);
  });

  it("counts activity inside an element, in the capture phase, even if the target stops propagation", () => {
    start();
    const terminal = document.createElement("div");
    terminal.addEventListener("keydown", (event) => event.stopPropagation());
    document.body.append(terminal);
    terminal.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    expect(sent).toEqual([ROUTE]);
    terminal.remove();
  });

  it("sends nothing while the window is unfocused or the page is hidden", () => {
    start();
    focused = false;
    window.dispatchEvent(new Event("keydown"));
    focused = true;
    visibility = "hidden";
    window.dispatchEvent(new Event("pointerdown"));
    expect(sent).toEqual([]);
    visibility = "visible";
    window.dispatchEvent(new Event("pointerdown"));
    expect(sent).toHaveLength(1);
  });

  it("throttles repeat activity on the same route to once per 2 minutes", () => {
    start();
    window.dispatchEvent(new Event("keydown"));
    clock += ACTIVITY_INTERVAL_MS - 1;
    window.dispatchEvent(new Event("keydown"));
    expect(sent).toHaveLength(1);
    clock += 1;
    window.dispatchEvent(new Event("keydown"));
    expect(sent).toHaveLength(2);
  });

  it("sends at once when the route changed, and not again until it changes or 2 minutes pass", () => {
    start();
    window.dispatchEvent(new Event("keydown"));
    const next = { projectId: "prj_1", threadId: "thr_2" };
    // No activity in the last 2 s, so the change alone sends nothing.
    clock += NAVIGATION_GRACE_MS + 1;
    tracker.setRoute(next);
    expect(sent).toHaveLength(1);
    window.dispatchEvent(new Event("keydown"));
    expect(sent).toEqual([ROUTE, next]);
    window.dispatchEvent(new Event("keydown"));
    expect(sent).toHaveLength(2);
    tracker.setRoute({ projectId: null, threadId: null });
    window.dispatchEvent(new Event("wheel"));
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual({ projectId: null, threadId: null });
  });

  describe("a click that navigates", () => {
    const next = { projectId: "prj_1", threadId: "thr_2" };

    it("credits the new view when the route changes within 2 s of the activity", () => {
      start();
      window.dispatchEvent(new Event("pointerdown"));
      expect(sent).toEqual([ROUTE]);
      clock += NAVIGATION_GRACE_MS;
      tracker.setRoute(next);
      expect(sent).toEqual([ROUTE, next]);
      // The new view is now throttled like any other.
      window.dispatchEvent(new Event("pointerdown"));
      expect(sent).toHaveLength(2);
    });

    it("also credits it when the old view's activity was throttled", () => {
      start();
      window.dispatchEvent(new Event("keydown"));
      clock += 60_000;
      window.dispatchEvent(new Event("pointerdown"));
      expect(sent).toHaveLength(1);
      clock += 500;
      tracker.setRoute(next);
      expect(sent).toEqual([ROUTE, next]);
    });

    it("sends nothing when there was no recent activity, or the route did not change", () => {
      start();
      tracker.setRoute(next);
      expect(sent).toEqual([]);
      window.dispatchEvent(new Event("keydown"));
      sent.length = 0;
      tracker.setRoute(next);
      expect(sent).toEqual([]);
    });

    it("still honours focus and visibility", () => {
      start();
      window.dispatchEvent(new Event("pointerdown"));
      focused = false;
      tracker.setRoute(next);
      expect(sent).toEqual([ROUTE]);
      focused = true;
      visibility = "hidden";
      tracker.setRoute({ projectId: null, threadId: null });
      expect(sent).toEqual([ROUTE]);
    });
  });

  it("removes its listeners on dispose", () => {
    start();
    tracker.dispose();
    window.dispatchEvent(new Event("keydown"));
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("wheel"));
    expect(sent).toEqual([]);
  });
});
