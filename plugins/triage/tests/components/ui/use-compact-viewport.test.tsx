// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  CompactViewportOverrideProvider,
  useIsCompactViewport,
} from "@/components/ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@/components/ui/hooks/use-pointer-coarse";
import { installMatchMedia } from "./harness";

afterEach(() => {
  cleanup();
});

function ViewportProbe() {
  const isCompactViewport = useIsCompactViewport();
  return <span data-compact={isCompactViewport ? "yes" : "no"} />;
}

function CoarseProbe() {
  const isCoarse = usePointerCoarse();
  return <span data-coarse={isCoarse ? "yes" : "no"} />;
}

// use-compact-viewport tests.
describe("useIsCompactViewport", () => {
  it("falls back to the media query when no override is set", () => {
    installMatchMedia();
    render(<ViewportProbe />);
    // The setup matchMedia stub reports no match outside a real viewport.
    expect(document.querySelector("[data-compact]")?.getAttribute("data-compact")).toBe("no");
  });

  it("lets an override force the compact viewport on and off", () => {
    installMatchMedia();
    const view = render(
      <CompactViewportOverrideProvider isCompactViewport={true}>
        <ViewportProbe />
      </CompactViewportOverrideProvider>,
    );
    expect(document.querySelector("[data-compact]")?.getAttribute("data-compact")).toBe("yes");
    view.rerender(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <ViewportProbe />
      </CompactViewportOverrideProvider>,
    );
    expect(document.querySelector("[data-compact]")?.getAttribute("data-compact")).toBe("no");
  });

  it("still overrides when the media query itself matches", () => {
    const media = installMatchMedia();
    render(
      <CompactViewportOverrideProvider isCompactViewport={false}>
        <ViewportProbe />
      </CompactViewportOverrideProvider>,
    );
    const mediaProbe = render(<ViewportProbe />);
    act(() => {
      media.setMatches("(max-width: 767px)", true);
    });
    // The unoverridden probe follows the query; the overridden one stays put.
    const probes = document.querySelectorAll("[data-compact]");
    expect(probes[1]?.getAttribute("data-compact")).toBe("yes");
    expect(probes[0]?.getAttribute("data-compact")).toBe("no");
    mediaProbe.unmount();
  });
});

// use-pointer-coarse tests.
describe("usePointerCoarse", () => {
  it("follows the pointer-coarse media query", () => {
    const media = installMatchMedia();
    render(<CoarseProbe />);
    expect(document.querySelector("[data-coarse]")?.getAttribute("data-coarse")).toBe("no");
    act(() => {
      media.setMatches("(pointer: coarse)", true);
    });
    expect(document.querySelector("[data-coarse]")?.getAttribute("data-coarse")).toBe("yes");
  });
});
