// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { OverlayHarness } from "./harness";

afterEach(() => {
  cleanup();
});

interface DialogSceneProps {
  compact?: boolean;
  onEscapeKeyDown?: (event: Event) => void;
  onInteractOutside?: (event: Event) => void;
}

function DialogScene({ compact = false, onEscapeKeyDown, onInteractOutside }: DialogSceneProps) {
  return (
    <OverlayHarness compact={compact}>
      {({ open, setOpen }) => (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger className="px-2">Open dialog</DialogTrigger>
          <DialogContent className="extra-content" onEscapeKeyDown={onEscapeKeyDown} onInteractOutside={onInteractOutside}>
            <DialogHeader>
              <DialogTitle>Dialog title</DialogTitle>
              <DialogDescription>Dialog description</DialogDescription>
            </DialogHeader>
            <p>Dialog body</p>
            <DialogFooter>
              <DialogClose asChild>
                <a href="#dismiss">Dismiss link</a>
              </DialogClose>
              <DialogClose>Cancel button</DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </OverlayHarness>
  );
}

// dialog tests.
describe("Dialog on desktop", () => {
  it("opens from the trigger and shows the centered content with overlay and close X", () => {
    render(<DialogScene />);
    expect(screen.queryByText("Dialog title")).toBeNull();

    fireEvent.click(screen.getByText("Open dialog"));
    expect(screen.getByText("Dialog title")).toBeTruthy();
    expect(screen.getByText("Dialog description")).toBeTruthy();
    const content = document.querySelector('[class*="left-[50%]"]');
    expect(content).toBeTruthy();
    expect(content?.className).toContain("extra-content");
    expect(content?.querySelector('[data-icon="X"]')).toBeTruthy();
    const overlay = document.querySelector(".fixed.inset-0");
    expect(overlay?.getAttribute("data-bb-portaled-overlay")).toBe("");
    expect(screen.getByText("Dialog title").parentElement?.className).toContain("space-y-1.5");
    expect(screen.getByText("Cancel button").closest("div")?.className).toContain("flex-col-reverse");
  });

  it("closes from the footer close button and from the built-in X", () => {
    render(<DialogScene />);
    fireEvent.click(screen.getByText("Open dialog"));
    expect(screen.getByText("Dialog title")).toBeTruthy();

    fireEvent.click(screen.getByText("Cancel button"));
    expect(screen.queryByText("Dialog title")).toBeNull();

    fireEvent.click(screen.getByText("Open dialog"));
    const closeX = document
      .querySelector('[class*="left-[50%]"]')
      ?.querySelector("button");
    expect(closeX).toBeTruthy();
    fireEvent.click(closeX!);
    expect(screen.queryByText("Dialog title")).toBeNull();
  });

  it("keeps Radix behaviour on the trigger: mousedown prevents text selection", () => {
    render(<DialogScene />);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    screen.getByText("Open dialog").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("skips the open-blur when mousedown lands on an already open trigger", () => {
    render(<DialogScene />);
    fireEvent.click(screen.getByText("Open dialog"));
    expect(screen.getByText("Dialog title")).toBeTruthy();
    const focused = document.activeElement as HTMLElement;
    const blur = vi.spyOn(focused, "blur");

    // The dialog is open, so the trigger's mousedown must not blur anything.
    fireEvent.mouseDown(screen.getByText("Open dialog"));
    expect(blur).not.toHaveBeenCalled();
  });

  it("wires the Escape key handler on desktop and closes", () => {
    const onEscapeKeyDown = vi.fn();
    render(<DialogScene onEscapeKeyDown={onEscapeKeyDown} />);
    fireEvent.click(screen.getByText("Open dialog"));
    expect(screen.getByText("Dialog title")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Dialog title")).toBeNull();
  });
});

// dialog tests.
describe("Dialog on a compact viewport", () => {
  it("opens as a drawer, maps the title and description to drawer parts, and strips Radix props", () => {
    const onEscapeKeyDown = vi.fn();
    const onInteractOutside = vi.fn();
    render(<DialogScene compact={true} onEscapeKeyDown={onEscapeKeyDown} onInteractOutside={onInteractOutside} />);
    expect(screen.queryByText("Dialog title")).toBeNull();

    fireEvent.click(screen.getByText("Open dialog"));
    // DialogTitle and DialogDescription render through the drawer primitives.
    expect(screen.getByText("Dialog title").tagName).toBe("H2");
    expect(screen.getByText("Dialog description").tagName).toBe("P");
    const inner = document.querySelector(".extra-content");
    expect(inner?.className).toContain("max-w-none");
    expect(screen.getByText("Dialog body").closest("div")?.className).toContain("grid");
    expect(onInteractOutside).not.toHaveBeenCalled();

    // The stripped Radix handlers are not wired: Escape only closes the drawer.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscapeKeyDown).not.toHaveBeenCalled();
    expect(onInteractOutside).not.toHaveBeenCalled();
    expect(screen.queryByText("Dialog title")).toBeNull();
  });

  it("closes from both footer close variants", () => {
    render(<DialogScene compact={true} />);
    fireEvent.click(screen.getByText("Open dialog"));
    expect(screen.getByText("Dialog title")).toBeTruthy();

    fireEvent.click(screen.getByText("Cancel button"));
    expect(screen.queryByText("Dialog title")).toBeNull();

    fireEvent.click(screen.getByText("Open dialog"));
    fireEvent.click(screen.getByText("Dismiss link"));
    expect(screen.queryByText("Dialog title")).toBeNull();
  });

  it("keeps the drawer open when the close button's own onClick prevents default", () => {
    render(
      <OverlayHarness compact={true}>
        {({ open, setOpen }) => (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger>Open dialog</DialogTrigger>
            <DialogContent>
              <DialogTitle>Dialog title</DialogTitle>
              <DialogClose onClick={(event) => event.preventDefault()}>Stay button</DialogClose>
            </DialogContent>
          </Dialog>
        )}
      </OverlayHarness>,
    );
    fireEvent.click(screen.getByText("Open dialog"));
    expect(screen.getByText("Dialog title")).toBeTruthy();

    fireEvent.click(screen.getByText("Stay button"));
    expect(screen.getByText("Dialog title")).toBeTruthy();
  });

  it("exposes the trigger as a mobile trigger with menu-dialog semantics", () => {
    render(<DialogScene compact={true} />);
    const trigger = screen.getByText("Open dialog");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("data-state")).toBe("closed");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("data-state")).toBe("open");
  });
});
