// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  claimTriageRefresh,
  requestOpenTaskDetail,
  usePendingOpenTaskDetail,
} from "../../lib/triage-mounts.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("claimTriageRefresh", () => {
  test("unstamped payloads always claim", () => {
    expect(claimTriageRefresh(undefined)).toBe(true);
    expect(claimTriageRefresh(null)).toBe(true);
    expect(claimTriageRefresh({})).toBe(true);
    expect(claimTriageRefresh({ at: "soon" })).toBe(true);
  });

  test("a stamped payload claims once; a new stamp claims again", () => {
    expect(claimTriageRefresh({ at: 100 })).toBe(true);
    expect(claimTriageRefresh({ at: 100 })).toBe(false);
    expect(claimTriageRefresh({ at: 200 })).toBe(true);
    expect(claimTriageRefresh({ at: 200 })).toBe(false);
  });
});

describe("requestOpenTaskDetail and usePendingOpenTaskDetail", () => {
  test("a request travels straight to every mounted surface", () => {
    const seen: number[] = [];
    const first = renderHook(() => usePendingOpenTaskDetail((n) => seen.push(n)));
    const second = renderHook(() => usePendingOpenTaskDetail((n) => seen.push(n + 100)));
    act(() => requestOpenTaskDetail(7));
    expect(seen).toStrictEqual([7, 107]);
    first.unmount();
    second.unmount();
    act(() => requestOpenTaskDetail(8));
    expect(seen).toStrictEqual([7, 107]);
  });

  test("a request from before the board mounts waits and is delivered once", () => {
    act(() => requestOpenTaskDetail(3));
    const seen: number[] = [];
    const handle = renderHook(() => usePendingOpenTaskDetail((n) => seen.push(n)));
    expect(seen).toStrictEqual([3]);
    handle.rerender();
    expect(seen).toStrictEqual([3]);
    handle.unmount();
    const next = renderHook(() => usePendingOpenTaskDetail((n) => seen.push(n)));
    expect(seen).toStrictEqual([3]);
    next.unmount();
  });

  test("handlers are read through a ref, so the latest callback answers", () => {
    const seen: string[] = [];
    const handle = renderHook((who: string) => usePendingOpenTaskDetail((n) => seen.push(`${who}:${n}`)), {
      initialProps: "first",
    });
    handle.rerender("second");
    act(() => requestOpenTaskDetail(9));
    expect(seen).toStrictEqual(["second:9"]);
    handle.unmount();
  });
});
