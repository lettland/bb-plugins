// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { OverlayHarness } from "./harness";

afterEach(() => {
  cleanup();
});

interface PopoverSceneProps {
  compact?: boolean;
  defaultOpen?: boolean;
  asChildTrigger?: boolean;
  withAnchor?: boolean;
  mobileTitle?: string;
  mobileClassName?: string;
  plain?: boolean;
}

function PopoverScene({
  compact = false,
  defaultOpen = false,
  asChildTrigger = false,
  withAnchor = false,
  mobileTitle,
  mobileClassName,
  plain = false,
}: PopoverSceneProps) {
  return (
    <OverlayHarness compact={compact}>
      {({ open, setOpen }) => (
        <Popover open={defaultOpen ? undefined : open} onOpenChange={setOpen} defaultOpen={defaultOpen}>
          {withAnchor ? <PopoverAnchor asChild><span id="anchor">Anchor text</span></PopoverAnchor> : null}
          {asChildTrigger ? (
            <PopoverTrigger asChild>
              <button type="button" className="px-2">Open popover</button>
            </PopoverTrigger>
          ) : (
            <PopoverTrigger className="px-2">Open popover</PopoverTrigger>
          )}
          <PopoverContent
            align={plain ? undefined : "start"}
            sideOffset={plain ? undefined : 8}
            mobileTitle={mobileTitle}
            mobileClassName={mobileClassName}
            data-testid="popover-content"
            sticky="always"
          >
            <p>Popover body</p>
          </PopoverContent>
        </Popover>
      )}
    </OverlayHarness>
  );
}

// popover tests.
describe("Popover on desktop", () => {
  it("opens from the trigger, anchors, and closes from outside and Escape", () => {
    render(<PopoverScene withAnchor={true} />);
    expect(screen.queryByText("Popover body")).toBeNull();
    expect(document.getElementById("anchor")?.textContent).toBe("Anchor text");

    fireEvent.click(screen.getByText("Open popover"));
    expect(screen.getByText("Popover body")).toBeTruthy();
    const content = screen.getByTestId("popover-content");
    expect(content.className).toContain("w-96");
    expect(content.getAttribute("data-align")).toBe("start");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Popover body")).toBeNull();
  });

  it("opens immediately with defaultOpen, renders the anchor wrapper, and takes the offset defaults", () => {
    render(<PopoverScene defaultOpen={true} withAnchor={true} plain={true} />);
    expect(screen.getByText("Popover body")).toBeTruthy();
    const content = screen.getByTestId("popover-content");
    expect(content.getAttribute("data-align")).toBe("center");
    expect(document.getElementById("anchor")).toBeTruthy();
  });

  it("keeps Radix behaviour on the trigger: mousedown prevents text selection", () => {
    render(<PopoverScene />);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    screen.getByText("Open popover").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("skips the open-blur when mousedown lands on an already open trigger", () => {
    render(<PopoverScene />);
    fireEvent.click(screen.getByText("Open popover"));
    expect(screen.getByText("Popover body")).toBeTruthy();
    const focused = document.activeElement as HTMLElement;
    const blur = vi.spyOn(focused, "blur");

    // The popover is open, so the trigger's mousedown must not blur anything.
    fireEvent.mouseDown(screen.getByText("Open popover"));
    expect(blur).not.toHaveBeenCalled();
  });
});

// popover tests.
describe("Popover on a compact viewport", () => {
  it("opens as a drawer with the default sr label and strips Radix-only props", () => {
    render(<PopoverScene compact={true} />);
    expect(screen.queryByText("Popover body")).toBeNull();

    fireEvent.click(screen.getByText("Open popover"));
    expect(screen.getByText("Options")).toBeTruthy();
    const content = screen.getByTestId("popover-content");
    expect(content.className).toContain("overflow-y-auto");
    expect(content.getAttribute("sticky")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Popover body")).toBeNull();
  });

  it("passes the mobile title and content class through to the drawer", () => {
    render(<PopoverScene compact={true} mobileTitle="Filter options" mobileClassName="extra-drawer" />);
    fireEvent.click(screen.getByText("Open popover"));
    expect(screen.getByText("Filter options")).toBeTruthy();
    expect(document.querySelector(".extra-drawer")).toBeTruthy();
  });

  it("opens through an asChild trigger and renders the anchor children bare", () => {
    render(<PopoverScene compact={true} asChildTrigger={true} withAnchor={true} />);
    const trigger = screen.getByText("Open popover");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(trigger);
    expect(screen.getByText("Popover body")).toBeTruthy();
    expect(document.getElementById("anchor")).toBeTruthy();
  });

  it("blur before open clears a focused input from the mobile trigger", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(input);
    input.focus();
    render(<PopoverScene compact={true} />);
    fireEvent.click(screen.getByText("Open popover"));
    expect(document.activeElement).toBe(document.body);
  });
});
