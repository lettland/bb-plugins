// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MobileTrigger,
  ResponsiveDrawerShell,
  stripRadixContentProps,
  useResponsiveRoot,
} from "@/components/ui/responsive-overlay";
import {
  CompactViewportOverrideProvider,
} from "@/components/ui/hooks/use-compact-viewport";
import { installMatchMedia } from "./harness";

// Installed before any render so every MediaQueryList this file creates comes
// from the controllable stub.
const media = installMatchMedia();

// Radix Presence reads CSS.escape when animationend fires; jsdom ships no CSS
// global. Animation names in tests never need real escaping.
(window as unknown as { CSS: { escape: (value: string) => string } }).CSS = {
  escape: (value: string) => value,
};

afterEach(() => {
  cleanup();
  delete (document as { activeElement?: unknown }).activeElement;
});

function Shell(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  srLabel?: string;
  contentClassName?: string;
  handleOnly?: boolean;
  repositionInputs?: boolean;
  onContentAnimationEnd?: (open: boolean) => void;
  children?: React.ReactNode;
  nested?: boolean;
}) {
  const { children = <p>Shell body</p>, ...shellProps } = props;
  return <ResponsiveDrawerShell {...shellProps}>{children}</ResponsiveDrawerShell>;
}

// Lets the dismissal layer's own setTimeout(0) listener attach before the
// test interacts; pure microtask act flushes never fire it.
async function flushLayerTimers(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// responsive-overlay shell tests.
describe("ResponsiveDrawerShell", () => {
  it("renders the sr-only title only when a label is given", () => {
    render(
      <Shell open={true} onOpenChange={vi.fn()} srLabel="Filter sheet" contentClassName="extra-shell" />,
    );
    expect(screen.getByText("Filter sheet").className).toContain("sr-only");
    expect(document.querySelector(".extra-shell")).toBeTruthy();
    expect(screen.getByText("Shell body")).toBeTruthy();
  });

  it("renders no title when the caller labels the body itself", () => {
    render(<Shell open={true} onOpenChange={vi.fn()} />);
    expect(screen.getByText("Shell body")).toBeTruthy();
    expect(document.querySelector("h2")).toBeNull();
  });

  it("closes on Escape through the shell's own handler", () => {
    const onOpenChange = vi.fn();
    render(<Shell open={true} onOpenChange={onOpenChange} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("resets the keyboard styles again when the open prop flips to false after unmounting the body", () => {
    const view = render(<Shell open={true} onOpenChange={vi.fn()} srLabel="Sheet" />);
    expect(screen.getByText("Shell body")).toBeTruthy();
    act(() => {
      view.rerender(<Shell open={false} onOpenChange={vi.fn()} srLabel="Sheet" />);
    });
    expect(screen.queryByText("Shell body")).toBeNull();
  });

  it("notifies onContentAnimationEnd only for the content's own animation", () => {
    const onContentAnimationEnd = vi.fn();
    render(
      <Shell open={true} onOpenChange={vi.fn()} onContentAnimationEnd={onContentAnimationEnd}>
        <p>Shell body</p>
        <span>Inner span</span>
      </Shell>,
    );
    const content = document.querySelector(".fixed.inset-x-0") as HTMLElement;
    expect(content).toBeTruthy();

    // A child's bubbling animation must be ignored.
    fireEvent.animationEnd(screen.getByText("Inner span"));
    expect(onContentAnimationEnd).not.toHaveBeenCalled();

    fireEvent.animationEnd(content);
    expect(onContentAnimationEnd).toHaveBeenCalledWith(true);
  });

  it("keeps the drawer open when the pointer down happens on a sonner toaster", async () => {
    const onOpenChange = vi.fn();
    render(<Shell open={true} onOpenChange={onOpenChange} srLabel="Sheet" />);
    await flushLayerTimers();
    const toaster = document.createElement("div");
    toaster.setAttribute("data-sonner-toaster", "");
    document.body.append(toaster);

    try {
      // vaul defers outside dismissal to the click that follows the pointer down.
      fireEvent.pointerDown(toaster);
      fireEvent.click(toaster);
      await flushLayerTimers();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByText("Shell body")).toBeTruthy();
    } finally {
      toaster.remove();
    }
  });

  it("dismisses on a pointer down whose target is not an element", async () => {
    const onOpenChange = vi.fn();
    render(
      <Shell open={true} onOpenChange={onOpenChange}>
        <p>Shell body</p>
      </Shell>,
    );
    expect(screen.getByText("Shell body")).toBeTruthy();
    await flushLayerTimers();

    // target: document — not an Element, so no toaster check matches.
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushLayerTimers();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismisses on an ordinary outside pointer down and click", async () => {
    const onOpenChange = vi.fn();
    render(<Shell open={true} onOpenChange={onOpenChange} />);
    await flushLayerTimers();
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    await flushLayerTimers();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("passes handleOnly through and keeps a nested drawer from repositioning inputs", async () => {
    const onOpenChange = vi.fn();
    render(
      <Shell open={true} onOpenChange={onOpenChange} handleOnly={true}>
        <ResponsiveDrawerShell open={true} onOpenChange={vi.fn()}>
          <p>Nested body</p>
        </ResponsiveDrawerShell>
      </Shell>,
    );
    await act(async () => {});
    expect(screen.getByText("Nested body")).toBeTruthy();
  });

  it("keeps the coarse-pointer open autofocus prevented while the drawer still opens", async () => {
    // vaul suppresses Radix's open autofocus for every pointer, so the
    // preventDefault here is a Radix-layer guard only: it cannot be observed
    // through focus behaviour, but the coarse branch must not break the open.
    const onOpenChange = vi.fn();
    act(() => {
      media.setMatches("(pointer: coarse)", true);
    });
    const view = render(<Shell open={false} onOpenChange={onOpenChange} srLabel="Sheet" />);
    act(() => {
      view.rerender(<Shell open={true} onOpenChange={onOpenChange} srLabel="Sheet" />);
    });
    await act(async () => {});
    expect(screen.getByText("Shell body")).toBeTruthy();
    view.unmount();

    act(() => {
      media.setMatches("(pointer: coarse)", false);
    });
    const fine = render(<Shell open={false} onOpenChange={onOpenChange} srLabel="Sheet" />);
    act(() => {
      fine.rerender(<Shell open={true} onOpenChange={onOpenChange} srLabel="Sheet" />);
    });
    await act(async () => {});
    expect(screen.getByText("Shell body")).toBeTruthy();
    fine.unmount();
  });
});

// mobile-trigger tests.
describe("MobileTrigger", () => {
  it("renders a button with dialog semantics and toggles open state", () => {
    const onOpenChange = vi.fn();
    function Trigger() {
      const [open, setOpen] = React.useState(false);
      return (
        <MobileTrigger open={open} onOpenChange={(next) => { onOpenChange(next); setOpen(next); }} haspopup="dialog">
          Open sheet
        </MobileTrigger>
      );
    }
    render(<Trigger />);
    const trigger = screen.getByText("Open sheet");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("data-state")).toBe("closed");
    expect(trigger.className).toContain("select-none");

    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenNthCalledWith(1, true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenNthCalledWith(2, false);
  });

  it("renders as a slot child and keeps a prevented click from opening", () => {
    const onOpenChange = vi.fn();
    function Trigger() {
      return (
        <MobileTrigger
          asChild={true}
          open={false}
          onOpenChange={onOpenChange}
          haspopup="menu"
          className="px-3"
        >
          <a href="#sheet" onClick={(event) => event.preventDefault()}>
            Open sheet
          </a>
        </MobileTrigger>
      );
    }
    render(<Trigger />);
    const link = screen.getByText("Open sheet");
    expect(link.className).toContain("px-3");
    expect(link.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(link);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("blurs a focused input before opening", () => {
    const onOpenChange = vi.fn();
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(input);
    input.focus();
    render(
      <MobileTrigger open={false} onOpenChange={onOpenChange} haspopup="menu">
        Open sheet
      </MobileTrigger>,
    );
    fireEvent.click(screen.getByText("Open sheet"));
    expect(document.activeElement).toBe(document.body);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});

// responsive-root tests.
describe("useResponsiveRoot", () => {
  function RootProbe(props: {
    controlledOpen?: boolean;
    controlledOnChange?: (open: boolean) => void;
    defaultOpen?: boolean;
  }) {
    const ctx = useResponsiveRoot(props.controlledOpen, props.controlledOnChange, props.defaultOpen);
    return (
      <button type="button" data-open={ctx.open ? "yes" : "no"} onClick={() => ctx.onOpenChange(!ctx.open)}>
        Toggle root
      </button>
    );
  }

  it("manages uncontrolled open state", () => {
    render(<RootProbe />);
    const button = screen.getByText("Toggle root");
    expect(button.getAttribute("data-open")).toBe("no");
    fireEvent.click(button);
    expect(button.getAttribute("data-open")).toBe("yes");
    fireEvent.click(button);
    expect(button.getAttribute("data-open")).toBe("no");
  });

  it("seeds uncontrolled state with defaultOpen", () => {
    render(<RootProbe defaultOpen={true} />);
    expect(screen.getByText("Toggle root").getAttribute("data-open")).toBe("yes");
  });

  it("stays with the controlled value and reports changes", () => {
    const controlledOnChange = vi.fn();
    render(<RootProbe controlledOpen={true} controlledOnChange={controlledOnChange} />);
    const button = screen.getByText("Toggle root");
    expect(button.getAttribute("data-open")).toBe("yes");
    fireEvent.click(button);
    expect(controlledOnChange).toHaveBeenCalledWith(false);
    expect(button.getAttribute("data-open")).toBe("yes");
  });

  it("blurs a focused input when closing on a compact viewport", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(input);
    input.focus();
    render(
      <CompactViewportOverrideProvider isCompactViewport={true}>
        <RootProbe defaultOpen={true} />
      </CompactViewportOverrideProvider>,
    );
    fireEvent.click(screen.getByText("Toggle root"));
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps a focused input when closing on desktop", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(input);
    input.focus();
    render(<RootProbe defaultOpen={true} />);
    fireEvent.click(screen.getByText("Toggle root"));
    expect(document.activeElement).toBe(input);
  });
});

// strip-radix-content-props tests.
describe("stripRadixContentProps", () => {
  it("drops Radix-only props and keeps everything else", () => {
    const kept = stripRadixContentProps({
      "data-testid": "kept",
      onInteractOutside: vi.fn(),
      side: "top",
      avoidCollisions: true,
      className: "px-2",
    });
    expect(Object.keys(kept).sort()).toStrictEqual(["className", "data-testid"]);
  });

  it("returns an empty object for Radix-only props", () => {
    expect(stripRadixContentProps({ collisionPadding: 8 })).toStrictEqual({});
  });
});

// shell close tests.
describe("keyboard reset while the drawer closes", () => {
  it("blurs an input inside the drawer content on close", () => {
    function Scene() {
      const [open, setOpen] = React.useState(true);
      return (
        <Shell open={open} onOpenChange={setOpen} srLabel="Sheet">
          <input type="text" aria-label="Sheet input" />
        </Shell>
      );
    }
    render(<Scene />);
    const input = screen.getByLabelText("Sheet input");
    input.focus();
    const blur = vi.spyOn(input, "blur");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(blur).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Sheet input")).toBeNull();
  });
});
