// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MENU_ITEM_LAST_HOVERED_CLASS,
  MenuHoverProvider,
  useMenuItemHover,
} from "@/components/ui/menu-item-hover";

afterEach(() => {
  cleanup();
});

function HoverProbe({
  onPointerEnter,
  onKeyDown,
}: {
  onPointerEnter?: React.PointerEventHandler;
  onKeyDown?: React.KeyboardEventHandler;
}) {
  const { isLastHovered, hoverProps } = useMenuItemHover({ onPointerEnter, onKeyDown });
  return (
    <button type="button" data-hovered={isLastHovered ? "" : undefined} {...hoverProps}>
      Probe
    </button>
  );
}

// menu-item-hover tests.
describe("MenuHoverProvider", () => {
  it("persists the last pointer-hovered item and moves it to the next hover", () => {
    render(
      <MenuHoverProvider>
        <HoverProbe />
        <HoverProbe />
      </MenuHoverProvider>,
    );
    const [first, second] = screen.getAllByText("Probe");
    expect(first!.getAttribute("data-last-hovered")).toBeNull();
    fireEvent.pointerOver(first!);
    expect(first!.getAttribute("data-last-hovered")).toBe("");
    expect(first!.getAttribute("data-hovered")).toBe("");
    fireEvent.pointerOver(second!);
    expect(first!.getAttribute("data-last-hovered")).toBeNull();
    expect(second!.getAttribute("data-last-hovered")).toBe("");
  });

  it("clears the highlight on the first navigation key but keeps it on other keys", () => {
    render(
      <MenuHoverProvider>
        <HoverProbe />
      </MenuHoverProvider>,
    );
    const probe = screen.getByText("Probe");
    fireEvent.pointerOver(probe);
    expect(probe.getAttribute("data-last-hovered")).toBe("");
    fireEvent.keyDown(probe, { key: "a" });
    expect(probe.getAttribute("data-last-hovered")).toBe("");
    fireEvent.keyDown(probe, { key: "ArrowDown" });
    expect(probe.getAttribute("data-last-hovered")).toBeNull();
    expect(probe.getAttribute("data-hovered")).toBeNull();
  });

  it("runs the caller's handlers alongside the glue", () => {
    const onPointerEnter = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <MenuHoverProvider>
        <HoverProbe onPointerEnter={onPointerEnter} onKeyDown={onKeyDown} />
      </MenuHoverProvider>,
    );
    const probe = screen.getByText("Probe");
    fireEvent.pointerOver(probe);
    fireEvent.keyDown(probe, { key: "Enter" });
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(probe.getAttribute("data-last-hovered")).toBe("");
  });

  it("resets the highlight when the provider unmounts and remounts", () => {
    const view = render(
      <MenuHoverProvider>
        <HoverProbe />
      </MenuHoverProvider>,
    );
    const probe = screen.getByText("Probe");
    fireEvent.pointerOver(probe);
    expect(probe.getAttribute("data-last-hovered")).toBe("");
    view.unmount();
    render(
      <MenuHoverProvider>
        <HoverProbe />
      </MenuHoverProvider>,
    );
    expect(screen.getByText("Probe").getAttribute("data-last-hovered")).toBeNull();
  });
});

describe("useMenuItemHover without a provider", () => {
  it("is an inert no-op: handlers run, no highlight is stored", () => {
    const onPointerEnter = vi.fn();
    render(<HoverProbe onPointerEnter={onPointerEnter} />);
    const probe = screen.getByText("Probe");
    act(() => {
      fireEvent.pointerOver(probe);
    });
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(probe.getAttribute("data-last-hovered")).toBeNull();
    fireEvent.keyDown(probe, { key: "End" });
    expect(probe.getAttribute("data-last-hovered")).toBeNull();
  });
});

describe("MENU_ITEM_LAST_HOVERED_CLASS", () => {
  it("targets the last-hovered data attribute", () => {
    expect(MENU_ITEM_LAST_HOVERED_CLASS).toContain("data-[last-hovered]:bg-state-hover");
  });
});
