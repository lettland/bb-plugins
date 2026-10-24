// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OverlayHarness } from "./harness";

afterEach(() => {
  cleanup();
});

// The compact item branches spread {...domProps} onto their rendered <button>;
// these tests keep that fix verifiable in isolation from the full menu suite.
describe("compact dropdown items forward dom props", () => {
  it("carries data-testid and aria-label on the compact DropdownMenuItem button", () => {
    render(
      <OverlayHarness compact={true}>
        {({ open, setOpen }) => (
          <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem data-testid="probe-item" aria-label="Probe item">
                Probe
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </OverlayHarness>,
    );
    fireEvent.click(screen.getByText("Actions"));
    const item = screen.getByTestId("probe-item");
    expect(item.tagName).toBe("BUTTON");
    expect(item.getAttribute("aria-label")).toBe("Probe item");
    expect(item.getAttribute("role")).toBe("menuitem");
  });

  it("carries data-testid and aria-label on the compact DropdownMenuCheckboxItem button", () => {
    render(
      <OverlayHarness compact={true}>
        {({ open, setOpen }) => (
          <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuCheckboxItem checked={false} data-testid="probe-check" aria-label="Probe check">
                Probe box
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </OverlayHarness>,
    );
    fireEvent.click(screen.getByText("Actions"));
    const item = screen.getByTestId("probe-check");
    expect(item.tagName).toBe("BUTTON");
    expect(item.getAttribute("aria-label")).toBe("Probe check");
    expect(item.getAttribute("role")).toBe("menuitemcheckbox");
  });

  it("keeps asChild from reaching the compact DropdownMenuItem button as a DOM attribute", () => {
    render(
      <OverlayHarness compact={true}>
        {({ open, setOpen }) => (
          <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem asChild data-testid="as-child-item" aria-label="As child item">
                Probe
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </OverlayHarness>,
    );
    fireEvent.click(screen.getByText("Actions"));
    const item = screen.getByTestId("as-child-item");
    expect(item.getAttributeNames().some((name) => name.toLowerCase() === "aschild")).toBe(false);
  });
});

describe("desktop dropdown items keep asChild", () => {
  it("merges asChild onto the child element instead of rendering a wrapper", () => {
    render(
      <OverlayHarness>
        {({ open, setOpen }) => (
          <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem asChild data-testid="slot-item" aria-label="Merged item">
                <button type="button">Slotted item</button>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </OverlayHarness>,
    );
    fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });
    // The slotted element owns the item role and props directly; a wrapper
    // would hold the role while the button stayed plain.
    const item = screen.getByTestId("slot-item");
    expect(item.tagName).toBe("BUTTON");
    expect(item.getAttribute("role")).toBe("menuitem");
    expect(item.getAttribute("aria-label")).toBe("Merged item");
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
  });
});
