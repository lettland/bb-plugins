// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useMediaQuery } from "@/components/ui/hooks/use-media-query";
import { installMatchMedia } from "./harness";

afterEach(() => {
  cleanup();
});

const COMPACT = "(max-width: 767px)";

function Probe({ query, onValue }: { query: string; onValue?: (value: boolean) => void }) {
  const matches = useMediaQuery(query);
  React.useEffect(() => {
    onValue?.(matches);
  }, [matches, onValue]);
  return <span data-matches={matches ? "yes" : "no"}>{query}</span>;
}

// use-media-query tests.
describe("useMediaQuery", () => {
  it("reports the initial match state and updates when the query flips", () => {
    const media = installMatchMedia();
    const seen: boolean[] = [];
    render(<Probe query={COMPACT} onValue={(value) => seen.push(value)} />);
    expect(screen.getByText(COMPACT).getAttribute("data-matches")).toBe("no");
    expect(seen).toEqual([false]);

    act(() => {
      media.setMatches(COMPACT, true);
    });
    expect(screen.getByText(COMPACT).getAttribute("data-matches")).toBe("yes");
    expect(seen).toEqual([false, true]);

    act(() => {
      media.setMatches(COMPACT, false);
    });
    expect(screen.getByText(COMPACT).getAttribute("data-matches")).toBe("no");
  });

  it("shares one MediaQueryList between concurrent subscribers and notifies both", () => {
    const media = installMatchMedia();
    render(
      <div>
        <Probe query={COMPACT} />
        <Probe query={COMPACT} />
        <Probe query="(pointer: coarse)" />
      </div>,
    );
    expect(media.matches(COMPACT)).toBe(false);
    act(() => {
      media.setMatches(COMPACT, true);
    });
    const spans = screen.getAllByText(COMPACT);
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => span.getAttribute("data-matches") === "yes")).toBe(true);
    expect(screen.getByText("(pointer: coarse)").getAttribute("data-matches")).toBe("no");
  });

  it("re-reads the cached list on rerender while subscribed", () => {
    const media = installMatchMedia();
    const view = render(<Probe query={COMPACT} />);
    act(() => {
      media.setMatches(COMPACT, true);
    });
    view.rerender(<Probe query={COMPACT} key="rerendered" />);
    expect(screen.getByText(COMPACT).getAttribute("data-matches")).toBe("yes");
  });

  it("releases the shared list when the last subscriber unmounts and reflects the current state on resubscribe", () => {
    const media = installMatchMedia();
    const view = render(<Probe query={COMPACT} />);
    view.unmount();
    // With no subscriber left the cache dropped the list; the later flip has
    // no listeners to wake, and a fresh subscription must pick up the new
    // state rather than a stale cached snapshot.
    act(() => {
      media.setMatches(COMPACT, true);
    });
    render(<Probe query={COMPACT} />);
    expect(screen.getByText(COMPACT).getAttribute("data-matches")).toBe("yes");
  });
});
