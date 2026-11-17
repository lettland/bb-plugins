// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POINTER_COARSE_QUERY } from "@/components/ui/hooks/use-pointer-coarse";
import { PersistentResponsiveDrawerShell, useResponsiveDrawerRealization } from "@/components/ui/responsive-overlay";

const originalClientHeight = Object.getOwnPropertyDescriptor(document.documentElement, "clientHeight");
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalClientHeight) Object.defineProperty(document.documentElement, "clientHeight", originalClientHeight);
  else Reflect.deleteProperty(document.documentElement, "clientHeight");
});
function mockPointerCoarse(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === POINTER_COARSE_QUERY && matches, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {},
    removeEventListener: () => {}, dispatchEvent: () => false,
  }));
}

it("cancels pending realization on close and retains content after the fallback", () => {
  vi.useFakeTimers();
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++next, callback); return next; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const hook = renderHook(({ open }) => useResponsiveDrawerRealization({ open }), { initialProps: { open: true } });
  hook.rerender({ open: false });
  expect(cancel).toHaveBeenCalledWith(1);
  hook.rerender({ open: true });
  act(() => { const callback = frames.get(2)!; frames.delete(2); callback(0); });
  hook.rerender({ open: false });
  expect(cancel).toHaveBeenCalledWith(3);
  hook.rerender({ open: true });
  act(() => vi.advanceTimersByTime(120));
  expect(hook.result.current.isContentRealized).toBe(true);
  hook.rerender({ open: false });
  expect(hook.result.current.isContentRealized).toBe(true);
});

describe("PersistentResponsiveDrawerShell", () => {
  it("keeps focus inside an empty drawer and moves between interior controls", () => {
    const view = render(<PersistentResponsiveDrawerShell open={true} onOpenChange={() => {}} srLabel="Details">{null}</PersistentResponsiveDrawerShell>);
    const panel = screen.getByRole("dialog", { name: "Details" });
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(panel);
    view.rerender(<PersistentResponsiveDrawerShell open={true} onOpenChange={() => {}} srLabel="Details">
      <button>First</button><button>Middle</button><button>Last</button>
    </PersistentResponsiveDrawerShell>);
    const middle = screen.getByRole("button", { name: "Middle" });
    middle.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
    middle.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("ignores unrelated pointer gestures and restores a cancelled drag", () => {
    const close = vi.fn();
    render(<PersistentResponsiveDrawerShell open={true} onOpenChange={close} srLabel="Details">{null}</PersistentResponsiveDrawerShell>);
    const panel = document.querySelector<HTMLElement>("[data-persistent-drawer-content]")!;
    const handle = document.querySelector<HTMLElement>("[data-persistent-drawer-handle]")!;
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 400 });
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerMove(handle, { pointerId: 4, clientY: 50 });
    fireEvent.pointerUp(handle, { pointerId: 4, clientY: 50 });
    fireEvent.pointerDown(handle, { button: 2, pointerId: 4, clientY: 0 });
    expect(handle.setPointerCapture).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 4, clientY: 0 });
    fireEvent.pointerMove(handle, { pointerId: 5, clientY: 200 });
    fireEvent.pointerCancel(handle, { pointerId: 4, clientY: 200 });
    expect(close).not.toHaveBeenCalled();
    expect(panel.style.transform).toBe("translate3d(0, 0px, 0)");
  });

  it("opens without applying modal state to the app tree", () => {
    mockPointerCoarse(true);
    const view = render(
      <>
        <main data-testid="large-app-tree" />
        <PersistentResponsiveDrawerShell
          open={false}
          onOpenChange={() => {}}
          srLabel="Details"
        >
          <button type="button">Panel action</button>
        </PersistentResponsiveDrawerShell>
      </>,
    );

    const appTree = screen.getByTestId("large-app-tree");
    const content = document.querySelector<HTMLElement>(
      "[data-persistent-drawer-content]",
    );
    expect(content).not.toBeNull();
    expect(content?.getAttribute("aria-hidden")).toBe("true");
    expect(appTree.getAttribute("aria-hidden")).toBeNull();
    expect(appTree.hasAttribute("inert")).toBe(false);
    const backdrop = document.querySelector<HTMLElement>(
      "[data-persistent-drawer-backdrop]",
    );
    expect(backdrop?.className).not.toContain("backdrop-blur");

    view.rerender(
      <>
        <main data-testid="large-app-tree" />
        <PersistentResponsiveDrawerShell
          open={true}
          onOpenChange={() => {}}
          srLabel="Details"
        >
          <button type="button">Panel action</button>
        </PersistentResponsiveDrawerShell>
      </>,
    );

    expect(content?.getAttribute("aria-hidden")).toBe("false");
    expect(appTree.getAttribute("aria-hidden")).toBeNull();
  });

  it("closes from the backdrop and the Escape key", () => {
    mockPointerCoarse(true);
    const onOpenChange = vi.fn();
    render(
      <PersistentResponsiveDrawerShell
        open={true}
        onOpenChange={onOpenChange}
        srLabel="Details"
      >
        <button type="button">Panel action</button>
      </PersistentResponsiveDrawerShell>,
    );

    fireEvent.click(
      document.querySelector<HTMLElement>(
        "[data-persistent-drawer-backdrop]",
      ) as HTMLElement,
    );
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: "a" });
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    const backdrop = document.querySelector<HTMLElement>("[data-persistent-drawer-backdrop]")!;
    fireEvent.touchMove(backdrop, { cancelable: true });
  });

  it("closes for a fast short drag", () => {
    const onOpenChange = vi.fn();
    vi.stubGlobal("PointerEvent", MouseEvent);
    render(<PersistentResponsiveDrawerShell open={true} onOpenChange={onOpenChange} srLabel="Details">{null}</PersistentResponsiveDrawerShell>);
    const panel = document.querySelector<HTMLElement>("[data-persistent-drawer-content]")!;
    const handle = document.querySelector<HTMLElement>("[data-persistent-drawer-handle]")!;
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 400 });
    handle.setPointerCapture = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    fireEvent.pointerDown(handle, { button: 0, clientY: 0, pointerId: 1 });
    now.mockReturnValue(110);
    fireEvent.pointerMove(handle, { clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 10, pointerId: 1 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("lets a nested portaled surface handle Escape first", () => {
    mockPointerCoarse(true);
    const onOpenChange = vi.fn();
    render(
      <PersistentResponsiveDrawerShell
        open={true}
        onOpenChange={onOpenChange}
        srLabel="Details"
      >
        <button type="button">Panel action</button>
      </PersistentResponsiveDrawerShell>,
    );

    const nestedAction = document.createElement("button");
    nestedAction.setAttribute("data-bb-portaled-overlay", "");
    nestedAction.addEventListener("keydown", (event) => {
      event.preventDefault();
    });
    document.body.appendChild(nestedAction);

    try {
      fireEvent.keyDown(nestedAction, { key: "Escape" });
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      nestedAction.remove();
    }
  });

  it("does not take Tab focus from a portaled child surface", () => {
    mockPointerCoarse(true);
    render(
      <PersistentResponsiveDrawerShell
        open={true}
        onOpenChange={() => {}}
        srLabel="Details"
      >
        <button type="button">Panel action</button>
      </PersistentResponsiveDrawerShell>,
    );

    const nestedAction = document.createElement("button");
    nestedAction.setAttribute("data-bb-portaled-overlay", "");
    document.body.appendChild(nestedAction);
    nestedAction.focus();

    try {
      fireEvent.keyDown(nestedAction, { key: "Tab" });
      expect(document.activeElement).toBe(nestedAction);
      fireEvent.keyDown(nestedAction, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(nestedAction);
    } finally {
      nestedAction.remove();
    }
  });

  it("closes nested drawers from the top and then closes the parent", () => {
    mockPointerCoarse(true);

    function NestedDrawers() {
      const [parentOpen, setParentOpen] = useState(true);
      const [childOpen, setChildOpen] = useState(false);
      return (
        <>
          <output data-testid="parent-state">{String(parentOpen)}</output>
          <output data-testid="child-state">{String(childOpen)}</output>
          <PersistentResponsiveDrawerShell
            open={parentOpen}
            onOpenChange={setParentOpen}
            srLabel="Parent"
          >
            <button type="button">Parent action</button>
            <button type="button" onClick={() => setChildOpen(true)}>
              Open child
            </button>
            <PersistentResponsiveDrawerShell
              open={childOpen}
              onOpenChange={setChildOpen}
              srLabel="Child"
            >
              <button type="button">Child action</button>
            </PersistentResponsiveDrawerShell>
          </PersistentResponsiveDrawerShell>
        </>
      );
    }

    render(<NestedDrawers />);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("child-state").textContent).toBe("false");
    expect(screen.getByTestId("parent-state").textContent).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("parent-state").textContent).toBe("false");
  });

  it("traps focus on coarse pointers and restores the trigger after close", () => {
    mockPointerCoarse(true);

    function FocusDrawer() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open details
          </button>
          <PersistentResponsiveDrawerShell
            open={open}
            onOpenChange={setOpen}
            srLabel="Details"
          >
            <button type="button">First action</button>
            <button type="button">Last action</button>
          </PersistentResponsiveDrawerShell>
        </>
      );
    }

    render(<FocusDrawer />);
    const trigger = screen.getByRole("button", { name: "Open details" });
    trigger.focus();
    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Details" });
    expect(document.activeElement).toBe(panel);

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "First action" }),
    );
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Last action" }),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });

  it("retries focus restoration after closing chrome becomes visible", () => {
    mockPointerCoarse(true);
    let frameCallback: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallback = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    function FocusDrawer() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open details
          </button>
          <PersistentResponsiveDrawerShell
            open={open}
            onOpenChange={setOpen}
            srLabel="Details"
          >
            <button type="button">Panel action</button>
          </PersistentResponsiveDrawerShell>
        </>
      );
    }

    render(<FocusDrawer />);
    const trigger = screen.getByRole("button", { name: "Open details" });
    trigger.focus();
    fireEvent.click(trigger);
    const nativeFocus = trigger.focus.bind(trigger);
    let restoreAttempts = 0;
    vi.spyOn(trigger, "focus").mockImplementation((options) => {
      restoreAttempts += 1;
      if (restoreAttempts > 1) nativeFocus(options);
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).not.toBe(trigger);
    act(() => frameCallback?.(0));
    expect(document.activeElement).toBe(trigger);
  });

  it("does not restore focus to a trigger hidden before the retry", () => {
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    function FocusDrawer() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open</button><PersistentResponsiveDrawerShell open={open} onOpenChange={setOpen} srLabel="Details">{null}</PersistentResponsiveDrawerShell></>;
    }
    render(<FocusDrawer />);
    const trigger = screen.getByRole("button", { name: "Open" });
    trigger.focus();
    fireEvent.click(trigger);
    vi.spyOn(trigger, "focus").mockImplementation(() => {});
    fireEvent.keyDown(document, { key: "Escape" });
    trigger.setAttribute("aria-hidden", "true");
    act(() => frame?.(0));
    expect(document.activeElement).not.toBe(trigger);
  });

  it("keeps panel focus and uses the latest close callback after a parent rerender", () => {
    mockPointerCoarse(false);
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(performance.now());
        return 1;
      });
    const firstOnOpenChange = vi.fn();
    const nextOnOpenChange = vi.fn();
    const view = render(
      <PersistentResponsiveDrawerShell
        open={true}
        onOpenChange={firstOnOpenChange}
        srLabel="Details"
      >
        <input aria-label="Panel input" />
      </PersistentResponsiveDrawerShell>,
    );
    const input = screen.getByRole("textbox", { name: "Panel input" });
    input.focus();

    view.rerender(
      <PersistentResponsiveDrawerShell
        open={true}
        onOpenChange={nextOnOpenChange}
        srLabel="Details"
      >
        <input aria-label="Panel input" />
      </PersistentResponsiveDrawerShell>,
    );

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    fireEvent.click(
      document.querySelector<HTMLElement>(
        "[data-persistent-drawer-backdrop]",
      ) as HTMLElement,
    );
    expect(firstOnOpenChange).not.toHaveBeenCalled();
    expect(nextOnOpenChange).toHaveBeenCalledWith(false);
    requestAnimationFrame.mockRestore();
  });

  it("closes when the handle moves past the drag threshold", () => {
    mockPointerCoarse(true);
    const onOpenChange = vi.fn();
    render(
      <PersistentResponsiveDrawerShell
        open={true}
        onOpenChange={onOpenChange}
        srLabel="Details"
      >
        <button type="button">Panel action</button>
      </PersistentResponsiveDrawerShell>,
    );

    const content = document.querySelector<HTMLElement>(
      "[data-persistent-drawer-content]",
    ) as HTMLElement;
    const handle = document.querySelector<HTMLElement>(
      "[data-persistent-drawer-handle]",
    ) as HTMLElement;
    const readHeight = vi.fn(() => 400);
    Object.defineProperty(content, "clientHeight", {
      configurable: true,
      get: readHeight,
    });
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, {
      button: 0,
      clientY: 200,
      pointerId: 1,
    });
    fireEvent.pointerMove(handle, { clientY: 330, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 330, pointerId: 1 });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(readHeight).toHaveBeenCalledTimes(1);
  });
});

describe("drawer software keyboard inset", () => {
  function mockVisualViewport(height: number) {
    const listeners = new Map<string, Set<() => void>>();
    const visualViewport = {
      height,
      offsetTop: 0,
      scale: 1,
      addEventListener: (type: string, listener: () => void) => {
        const set = listeners.get(type) ?? new Set<() => void>();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener);
      },
    };
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    return {
      visualViewport,
      emit: (type: string) => {
        for (const listener of listeners.get(type) ?? []) listener();
      },
      restore: () => {
        if (original === undefined) {
          Reflect.deleteProperty(window, "visualViewport");
          return;
        }
        Object.defineProperty(window, "visualViewport", original);
      },
    };
  }

  it("lifts the panel above the keyboard and restores it when dismissed", () => {
    mockPointerCoarse(true);
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 844,
    });
    const viewport = mockVisualViewport(844);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    try {
      const view = render(
        <PersistentResponsiveDrawerShell
          open={true}
          onOpenChange={() => {}}
          srLabel="Model"
        >
          <button type="button">Panel action</button>
        </PersistentResponsiveDrawerShell>,
      );
      const panel = document.querySelector<HTMLElement>(
        "[data-persistent-drawer-content]",
      ) as HTMLElement;
      expect(panel.style.bottom).toBe("");

      act(() => {
        viewport.visualViewport.height = 508;
        viewport.emit("resize");
        for (const frame of frames.splice(0)) frame(0);
      });
      expect(panel.style.bottom).toBe("336px");
      expect(panel.style.getPropertyValue("--bb-drawer-keyboard-inset")).toBe(
        "336px",
      );

      act(() => {
        viewport.visualViewport.height = 844;
        viewport.emit("resize");
        for (const frame of frames.splice(0)) frame(0);
      });
      expect(panel.style.bottom).toBe("");
      expect(panel.style.getPropertyValue("--bb-drawer-keyboard-inset")).toBe(
        "",
      );
      const cancel = vi.spyOn(window, "cancelAnimationFrame");
      act(() => viewport.emit("resize"));
      view.unmount();
      expect(cancel).toHaveBeenCalled();
    } finally {
      viewport.restore();
    }
  });

  it("does not treat a zoomed and panned viewport as a keyboard", () => {
    mockPointerCoarse(true);
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 844,
    });
    const viewport = mockVisualViewport(844);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    try {
      render(
        <PersistentResponsiveDrawerShell
          open={true}
          onOpenChange={() => {}}
          srLabel="Image preview"
        >
          <img src="/preview.png" alt="Preview" />
        </PersistentResponsiveDrawerShell>,
      );
      const panel = document.querySelector<HTMLElement>(
        "[data-persistent-drawer-content]",
      ) as HTMLElement;

      act(() => {
        viewport.visualViewport.height = 422;
        viewport.visualViewport.offsetTop = 140;
        viewport.visualViewport.scale = 2;
        viewport.emit("resize");
        viewport.emit("scroll");
        for (const frame of frames.splice(0)) frame(0);
      });

      expect(panel.style.bottom).toBe("");
      expect(panel.style.getPropertyValue("--bb-drawer-keyboard-inset")).toBe(
        "",
      );
    } finally {
      viewport.restore();
    }
  });
});
