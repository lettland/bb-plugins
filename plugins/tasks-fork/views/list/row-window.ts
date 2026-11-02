import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";

export const ROW_WINDOW_THRESHOLD = 120;
const ROW_WINDOW_OVERSCAN_PX = 800;
const ROW_WINDOW_FALLBACK_ROWS = 60;
const ROW_WINDOW_SCROLL_STEP_PX = 200;

export interface RowWindowInput {
  counts: readonly number[];
  headerHeight: number;
  headerHeights?: readonly number[];
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
}

export type RowRange = readonly [start: number, end: number];

export function rowWindows({
  counts,
  headerHeight,
  headerHeights,
  rowHeight,
  scrollTop,
  viewportHeight,
}: RowWindowInput): RowRange[] {
  const ranges: RowRange[] = [];
  const windowRows =
    counts.reduce((total, count) => total + count, 0) >= ROW_WINDOW_THRESHOLD;
  let top = 0;
  for (const [index, count] of counts.entries()) {
    top += headerHeights?.[index] ?? headerHeight;
    if (!windowRows) {
      ranges.push([0, count]);
    } else if (viewportHeight <= 0 || rowHeight <= 0) {
      ranges.push([
        0,
        index === 0 ? Math.min(count, ROW_WINDOW_FALLBACK_ROWS) : 0,
      ]);
    } else {
      const from = scrollTop - ROW_WINDOW_OVERSCAN_PX - top;
      const to = scrollTop + viewportHeight + ROW_WINDOW_OVERSCAN_PX - top;
      const start = Math.min(count, Math.max(0, Math.floor(from / rowHeight)));
      const end = Math.min(count, Math.max(start, Math.ceil(to / rowHeight)));
      ranges.push([start, end]);
    }
    top += count * rowHeight;
  }
  return ranges;
}

interface Viewport {
  scrollTop: number;
  height: number;
  rowHeight: number;
  headerHeight: number;
  projectOffsetHeight: number;
}

function projectOffsetHeight(element: HTMLElement): number {
  const project = element.querySelector<HTMLElement>("[data-project-group]");
  const header = project?.querySelector<HTMLElement>(
    "[data-project-group-header]",
  );
  if (project === null || header === undefined || header === null) return 0;
  const style = getComputedStyle(project);
  return (
    header.offsetHeight +
    Number.parseFloat(style.marginBottom) +
    Number.parseFloat(style.borderBottomWidth)
  );
}

export function useRowWindowViewport(
  scrollRef: RefObject<HTMLElement | null>,
  measureKey: unknown,
): Viewport {
  const [viewport, setViewport] = useState<Viewport>({
    scrollTop: 0,
    height: 0,
    rowHeight: 0,
    headerHeight: 0,
    projectOffsetHeight: 0,
  });
  const frame = useRef<number | null>(null);

  const read = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const row = element.querySelector<HTMLElement>("[data-task-key]");
    const header = element.querySelector<HTMLElement>(
      "[data-status-group-header]",
    );
    setViewport((current) => {
      const next: Viewport = {
        scrollTop:
          Math.floor(element.scrollTop / ROW_WINDOW_SCROLL_STEP_PX) *
          ROW_WINDOW_SCROLL_STEP_PX,
        height: element.clientHeight,
        rowHeight: row?.offsetHeight ?? current.rowHeight,
        headerHeight: header?.offsetHeight ?? current.headerHeight,
        projectOffsetHeight: projectOffsetHeight(element),
      };
      return next.scrollTop === current.scrollTop &&
        next.height === current.height &&
        next.rowHeight === current.rowHeight &&
        next.headerHeight === current.headerHeight &&
        next.projectOffsetHeight === current.projectOffsetHeight
        ? current
        : next;
    });
  }, [scrollRef]);

  useLayoutEffect(() => {
    read();
  }, [read, measureKey]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const onScroll = () => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        read();
      });
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [scrollRef, read]);

  return viewport;
}

export function useListRowWindows(
  scrollRef: RefObject<HTMLElement | null>,
  counts: readonly number[],
  projectStarts: ReadonlySet<number> | null,
  measureKey: unknown,
) {
  const viewport = useRowWindowViewport(scrollRef, measureKey);
  const ranges = rowWindows({
    counts,
    headerHeight: viewport.headerHeight,
    ...(projectStarts === null
      ? {}
      : {
          headerHeights: counts.map(
            (_, index) =>
              viewport.headerHeight +
              (projectStarts.has(index) ? viewport.projectOffsetHeight : 0),
          ),
        }),
    rowHeight: viewport.rowHeight,
    scrollTop: viewport.scrollTop,
    viewportHeight: viewport.height,
  });
  return { viewport, ranges };
}
