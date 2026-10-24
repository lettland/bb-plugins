// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OverlayHarness } from "./harness";

afterEach(() => {
  cleanup();
});

interface MenuSceneProps {
  compact?: boolean;
  mobileTitle?: string;
  onSelectCut?: (event: Event) => void;
  onSelectKeepOpen?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  includeSub?: boolean;
}

// The full menu surface used by the desktop and compact suites below. The
// sub-menu branch is desktop-only: Radix's Sub requires the Root that the
// compact path never mounts.
function MenuScene({
  compact = false,
  mobileTitle,
  onSelectCut,
  onSelectKeepOpen,
  onCloseAutoFocus,
  includeSub = true,
}: MenuSceneProps) {
  return (
    <OverlayHarness compact={compact}>
      {({ open, setOpen }) => (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger className="px-2">Actions</DropdownMenuTrigger>
          <DropdownMenuContent mobileTitle={mobileTitle} onCloseAutoFocus={onCloseAutoFocus} sideOffset={8}>
            <DropdownMenuLabel>Available actions</DropdownMenuLabel>
            <DropdownMenuLabel inset>Inset label</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem data-testid="cut" onSelect={onSelectCut}>
                Cut
                <DropdownMenuShortcut>⌘X</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem inset data-testid="paste" onPointerEnter={undefined}>
                Paste
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={onSelectKeepOpen} data-testid="destroy">
                Destroy
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={true} data-testid="check-on">
              Autoplay
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={false} data-testid="check-off">
              Loop
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked="indeterminate" data-testid="check-mixed">
              Shuffle
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={false} disabled data-testid="check-locked">
              Locked
            </DropdownMenuCheckboxItem>
            <DropdownMenuRadioGroup value="a">
              <DropdownMenuRadioItem value="a" data-testid="radio-a">
                Radio A
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuRadioItem value="b" data-testid="radio-b">
              Radio B
            </DropdownMenuRadioItem>
            {includeSub ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger inset>More</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem>Deep item</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            <DropdownMenuItem
              disabled
              onSelect={onSelectKeepOpen}
              data-testid="blocked"
            >
              Blocked
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </OverlayHarness>
  );
}

// dropdown-menu tests.
describe("DropdownMenu on desktop", () => {
  it("opens from the trigger, blurring a focused input and preventing text selection", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(input);
    input.focus();
    render(<MenuScene />);
    const trigger = screen.getByText("Actions");
    expect(trigger.className).toContain("select-none");
    expect(trigger.className).toContain("px-2");
    expect(screen.queryByText("Cut")).toBeNull();

    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    trigger.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);

    fireEvent.pointerDown(trigger, { button: 0 });
    expect(screen.getByText("Available actions")).toBeTruthy();
    expect(screen.getByText("⌘X").className).toContain("tracking-widest");
  });

  it("opens with the keyboard and closes on Escape", async () => {
    render(<MenuScene />);
    fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });
    expect(screen.getByText("Cut")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Cut")).toBeNull());
  });

  it("closes when an item is selected and stays open when the select is prevented", async () => {
    const onSelectCut = vi.fn();
    const onSelectKeepOpen = vi.fn((event: Event) => event.preventDefault());
    render(<MenuScene onSelectCut={onSelectCut} onSelectKeepOpen={onSelectKeepOpen} />);
    fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });

    fireEvent.click(screen.getByTestId("cut"));
    expect(onSelectCut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Cut")).toBeNull());
  });

  it("applies the destructive variant and the persistent hover highlight", () => {
    render(<MenuScene />);
    fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });

    const cut = screen.getByTestId("cut");
    expect(cut.className).toContain("focus:bg-state-hover");
    expect(cut.className).toContain("data-[last-hovered]:bg-state-hover");
    const paste = screen.getByTestId("paste");
    expect(paste.className).toContain("pl-8");
    expect(screen.getByTestId("destroy").className).toContain("text-destructive");

    // Pointer hover persists via the last-hovered glue; keyboard clears it.
    fireEvent.pointerOver(cut);
    expect(cut.getAttribute("data-last-hovered")).toBe("");
    fireEvent.keyDown(cut, { key: "ArrowDown" });
    expect(cut.getAttribute("data-last-hovered")).toBeNull();
  });

  it("renders checkbox items with their check state and toggles them", () => {
    const onCheckedChange = vi.fn();
    function Scene() {
      const [checked, setChecked] = React.useState<boolean | "indeterminate">(true);
      return (
        <DropdownMenu defaultOpen={true}>
          <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem checked={checked} onCheckedChange={setChecked} data-testid="flag">
              Autoplay
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }
    render(<Scene />);
    const item = screen.getByTestId("flag");
    expect(item.getAttribute("aria-checked")).toBe("true");
    expect(item.querySelector('[data-icon="Check"]')).toBeTruthy();

    fireEvent.click(item);
    expect(item.getAttribute("aria-checked")).toBe("false");
  });

  it("renders the radio group with its indicator", () => {
    render(<MenuScene />);
    fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });
    const radio = screen.getByTestId("radio-a");
    expect(radio.getAttribute("role")).toBe("menuitemradio");
    expect(radio.querySelector("svg")).toBeTruthy();
  });

  it("renders the sub-menu trigger with its chevron", () => {
    render(<MenuScene />);
    fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });
    const subTrigger = screen.getByText("More");
    expect(subTrigger.querySelector('[data-icon="ChevronRight"]')).toBeTruthy();
  });

  it("skips disabled items when clicked", () => {
    const onSelectKeepOpen = vi.fn();
    render(<MenuScene onSelectKeepOpen={onSelectKeepOpen} />);
    fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });
    fireEvent.click(screen.getByTestId("blocked"));
    expect(onSelectKeepOpen).not.toHaveBeenCalled();
  });

  it("skips the open-blur when mousedown lands on an already open trigger", () => {
    render(<MenuScene />);
    fireEvent.pointerDown(screen.getByText("Actions"), { button: 0 });
    expect(screen.getByText("Cut")).toBeTruthy();
    const focused = document.activeElement as HTMLElement;
    const blur = vi.spyOn(focused, "blur");

    // The menu is open, so the trigger's mousedown must not blur anything.
    fireEvent.mouseDown(screen.getByText("Actions"));
    expect(blur).not.toHaveBeenCalled();
  });

  it("suppresses the close-time trigger refocus after a pointer-driven close", async () => {
    render(<MenuScene />);
    fireEvent.pointerDown(screen.getByText("Actions"), { button: 0 });
    expect(screen.getByText("Cut")).toBeTruthy();
    // The dismissal layer attaches its outside listener on a macrotask.
    await act(async () => {});

    fireEvent.pointerDown(document.body);
    await act(async () => {});
    expect(screen.queryByText("Cut")).toBeNull();
    // The suppressed refocus leaves the trigger unfocused.
    expect(document.activeElement).not.toBe(screen.getByText("Actions"));
  });

  it("keeps the close-time trigger refocus after a keyboard-driven close", async () => {
    const onCloseAutoFocus = vi.fn();
    render(<MenuScene onCloseAutoFocus={onCloseAutoFocus} />);
    fireEvent.keyDown(screen.getByText("Actions"), { key: "Enter" });
    expect(screen.getByText("Cut")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Cut")).toBeNull());
    expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByText("Actions"));
  });

  it("exposes the radix portal passthrough", () => {
    expect(DropdownMenuPortal).toBeTruthy();
  });
});

// dropdown-menu tests.
describe("DropdownMenu on a compact viewport", () => {
  it("opens as a drawer from the mobile trigger and blurs a focused input first", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(input);
    input.focus();
    render(<MenuScene compact={true}  includeSub={false}/>);
    const trigger = screen.getByText("Actions");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Cut")).toBeNull();

    fireEvent.click(trigger);
    expect(document.activeElement).toBe(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Menu")).toBeTruthy();
    expect(screen.getByText("Available actions")).toBeTruthy();
  });

  it("labels the drawer with the custom mobile title", () => {
    render(<MenuScene compact={true} mobileTitle="Thread actions"  includeSub={false}/>);
    fireEvent.click(screen.getByText("Actions"));
    expect(screen.getByText("Thread actions")).toBeTruthy();
    expect(screen.queryByText("Menu")).toBeNull();
  });

  it("closes when an item is tapped and reports the select event", () => {
    const onSelectCut = vi.fn();
    render(<MenuScene compact={true} onSelectCut={onSelectCut}  includeSub={false}/>);
    fireEvent.click(screen.getByText("Actions"));

    const item = screen.getByText("Cut");
    expect(item.tagName).toBe("BUTTON");
    expect(item.getAttribute("role")).toBe("menuitem");
    expect(item.getAttribute("type")).toBe("button");
    expect(item.className).toContain("focus:bg-state-hover");
    fireEvent.click(item);
    expect(onSelectCut).toHaveBeenCalledTimes(1);
    expect(onSelectCut.mock.calls[0]![0].type).toBe("select");
    expect(onSelectCut.mock.calls[0]![0].cancelable).toBe(true);
  });

  it("stays open when the select handler prevents the event", () => {
    const onSelectKeepOpen = vi.fn((event: Event) => event.preventDefault());
    render(<MenuScene compact={true} onSelectKeepOpen={onSelectKeepOpen}  includeSub={false}/>);
    fireEvent.click(screen.getByText("Actions"));
    fireEvent.click(screen.getByText("Destroy"));
    expect(onSelectKeepOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Destroy")).toBeTruthy();
  });

  it("ignores taps on disabled items", () => {
    const onSelectKeepOpen = vi.fn();
    render(<MenuScene compact={true} onSelectKeepOpen={onSelectKeepOpen}  includeSub={false}/>);
    fireEvent.click(screen.getByText("Actions"));
    const blocked = screen.getByText("Blocked") as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(blocked.getAttribute("data-disabled")).toBe("");
    fireEvent.click(blocked);
    expect(onSelectKeepOpen).not.toHaveBeenCalled();
  });

  it("maps checkbox states to aria-checked and toggles indeterminate to true", () => {
    render(<MenuScene compact={true}  includeSub={false}/>);
    fireEvent.click(screen.getByText("Actions"));
    const on = screen.getByRole("menuitemcheckbox", { name: "Autoplay" });
    const off = screen.getByRole("menuitemcheckbox", { name: "Loop" });
    const mixed = screen.getByRole("menuitemcheckbox", { name: "Shuffle" });
    expect(on.getAttribute("aria-checked")).toBe("true");
    expect(off.getAttribute("aria-checked")).toBe("false");
    expect(mixed.getAttribute("aria-checked")).toBe("mixed");
    expect(on.querySelector('[data-icon="Check"]')).toBeTruthy();
    expect(off.querySelector('[data-icon="Check"]')).toBeNull();
    expect(mixed.querySelector('[data-icon="Check"]')).toBeTruthy();
  });

  it("closes the drawer when a checkbox item is tapped without a prevented select", () => {
    render(<MenuScene compact={true}  includeSub={false}/>);
    fireEvent.click(screen.getByText("Actions"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Autoplay" }));
    expect(screen.queryByText("Autoplay")).toBeNull();
  });

  it("forwards dom props onto the compact item button", () => {
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
    expect(item.getAttribute("aria-label")).toBe("Probe item");
    expect(item.getAttribute("role")).toBe("menuitem");
    expect(item.textContent).toBe("Probe");
  });

  it("forwards dom props onto the compact checkbox item button", () => {
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
    expect(item.getAttribute("aria-label")).toBe("Probe check");
    expect(item.getAttribute("role")).toBe("menuitemcheckbox");
    expect(item.getAttribute("aria-checked")).toBe("false");
  });

  it("renders no radio group or radio items on the compact path", () => {
    render(<MenuScene compact={true}  includeSub={false}/>);
    fireEvent.click(screen.getByText("Actions"));
    expect(screen.getByText("Available actions")).toBeTruthy();
    expect(screen.queryByText("Radio A")).toBeNull();
    expect(screen.queryByText("Radio B")).toBeNull();
  });

  it("renders labels, separators, and groups as plain elements", () => {
    render(<MenuScene compact={true}  includeSub={false}/>);
    fireEvent.click(screen.getByText("Actions"));
    const label = screen.getByText("Available actions");
    expect(label.tagName).toBe("DIV");
    expect(label.className).toContain("text-muted-foreground");
    expect(document.querySelector("hr")).toBeTruthy();
    expect(screen.getByText("Cut").closest('[role="group"]')).toBeTruthy();
    expect(screen.getByText("Paste").className).toContain("pl-8");
  });

  it("opens through an asChild trigger", () => {
    render(
      <OverlayHarness compact={true}>
        {({ open, setOpen }) => (
          <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
              <button type="button">Slotted trigger</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Solo item</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </OverlayHarness>,
    );
    expect(screen.queryByText("Solo item")).toBeNull();
    fireEvent.click(screen.getByText("Slotted trigger"));
    expect(screen.getByText("Solo item")).toBeTruthy();
  });

  it("toggles a checkbox item through both directions with a prevented select", () => {
    const onCheckedChange = vi.fn();
    function Scene() {
      const [checked, setChecked] = React.useState<boolean | "indeterminate">("indeterminate");
      return (
        <OverlayHarness compact={true}>
          {({ open, setOpen }) => (
            <DropdownMenu open={open} onOpenChange={setOpen}>
              <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuCheckboxItem
                  checked={checked}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(next) => {
                    onCheckedChange(next);
                    setChecked(next);
                  }}
                >
                  Autoplay
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </OverlayHarness>
      );
    }
    render(<Scene />);
    fireEvent.click(screen.getByText("Actions"));
    const item = screen.getByRole("menuitemcheckbox", { name: "Autoplay" });
    expect(item.getAttribute("role")).toBe("menuitemcheckbox");
    expect(item.getAttribute("aria-checked")).toBe("mixed");

    // The prevented select keeps the drawer open across both toggle directions.
    fireEvent.click(item);
    expect(onCheckedChange).toHaveBeenNthCalledWith(1, true);
    expect(item.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(item);
    expect(onCheckedChange).toHaveBeenNthCalledWith(2, false);
    expect(item.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("menuitemcheckbox", { name: "Autoplay" })).toBeTruthy();
  });
});
