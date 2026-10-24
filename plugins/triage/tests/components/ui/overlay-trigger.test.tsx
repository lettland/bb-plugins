// @vitest-environment jsdom

import { cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  blurActiveKeyboardInputBeforeOverlayClose,
  blurActiveKeyboardInputBeforeOverlayOpen,
  blurActiveKeyboardInputWithin,
  getOverlayTriggerClassName,
  isLastInputKeyboard,
  preventOverlayTriggerSelection,
} from "@/components/ui/overlay-trigger";
import { patchContentEditable, setActiveElement } from "./harness";

afterEach(() => {
  cleanup();
  // Drop the own activeElement property so the prototype getter returns.
  delete (document as { activeElement?: unknown }).activeElement;
});

// overlay-trigger tests.
describe("getOverlayTriggerClassName", () => {
  it("stamps select-none and merges the caller's classes", () => {
    expect(getOverlayTriggerClassName()).toBe("select-none");
    expect(getOverlayTriggerClassName("px-2")).toBe("select-none px-2");
  });
});

describe("blurActiveKeyboardInputWithin", () => {
  it("blurs a focused text input", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    blurActiveKeyboardInputWithin(null);
    expect(document.activeElement).toBe(document.body);
  });

  it("blurs a focused textarea", () => {
    const area = document.createElement("textarea");
    document.body.append(area);
    area.focus();
    blurActiveKeyboardInputWithin(null);
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps a disabled input focused", () => {
    const input = document.createElement("input");
    input.disabled = true;
    document.body.append(input);
    const blur = vi.spyOn(input, "blur");
    setActiveElement(input);
    blurActiveKeyboardInputWithin(null);
    expect(blur).not.toHaveBeenCalled();
  });

  it("keeps a read-only input focused", () => {
    const input = document.createElement("input");
    input.readOnly = true;
    document.body.append(input);
    const blur = vi.spyOn(input, "blur");
    setActiveElement(input);
    blurActiveKeyboardInputWithin(null);
    expect(blur).not.toHaveBeenCalled();
  });

  it("keeps a focused non-text input type such as a range", () => {
    const input = document.createElement("input");
    input.type = "range";
    document.body.append(input);
    const blur = vi.spyOn(input, "blur");
    setActiveElement(input);
    blurActiveKeyboardInputWithin(null);
    expect(blur).not.toHaveBeenCalled();
  });

  it("blurs a focused contenteditable element", () => {
    const editor = document.createElement("div");
    document.body.append(editor);
    patchContentEditable(editor, true);
    const blur = vi.spyOn(editor, "blur");
    setActiveElement(editor);
    blurActiveKeyboardInputWithin(null);
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it("blurs an element nested in a contenteditable ancestor", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editor.append(child);
    document.body.append(editor);
    const blur = vi.spyOn(child, "blur");
    setActiveElement(child);
    blurActiveKeyboardInputWithin(null);
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it("keeps a plain focused element that is not an input", () => {
    const div = document.createElement("div");
    document.body.append(div);
    const blur = vi.spyOn(div, "blur");
    setActiveElement(div);
    blurActiveKeyboardInputWithin(null);
    expect(blur).not.toHaveBeenCalled();
  });

  it("keeps a focused non-HTML element such as an svg", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    document.body.append(svg);
    const blur = vi.spyOn(svg, "blur");
    setActiveElement(svg);
    blurActiveKeyboardInputWithin(null);
    expect(blur).not.toHaveBeenCalled();
  });

  it("keeps an active element that is not an element node at all", () => {
    setActiveElement(document);
    const blur = vi.spyOn(document.body, "blur");
    blurActiveKeyboardInputWithin(null);
    expect(blur).not.toHaveBeenCalled();
  });

  it("honours the container: blurs inputs inside it, keeps outside ones", () => {
    const inside = document.createElement("input");
    inside.type = "text";
    const container = document.createElement("div");
    container.append(inside);
    document.body.append(container);
    inside.focus();

    const outside = document.createElement("input");
    outside.type = "text";
    document.body.append(outside);
    outside.focus();

    blurActiveKeyboardInputWithin(container);
    expect(document.activeElement).toBe(outside);

    blurActiveKeyboardInputWithin(outside);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("blur helpers", () => {
  it("blurActiveKeyboardInputBeforeOverlayOpen blurs the focused input", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(input);
    input.focus();
    blurActiveKeyboardInputBeforeOverlayOpen();
    expect(document.activeElement).toBe(document.body);
  });

  it("blurActiveKeyboardInputBeforeOverlayClose blurs the focused input", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.append(input);
    input.focus();
    blurActiveKeyboardInputBeforeOverlayClose();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("preventOverlayTriggerSelection", () => {
  it("prevents the default of a mouse event", () => {
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    expect(event.defaultPrevented).toBe(false);
    preventOverlayTriggerSelection(event as unknown as React.MouseEvent);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("isLastInputKeyboard", () => {
  it("starts pointer, flips on keydown, and back on pointerdown", () => {
    expect(isLastInputKeyboard()).toBe(false);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(isLastInputKeyboard()).toBe(true);
    fireEvent.pointerDown(document);
    expect(isLastInputKeyboard()).toBe(false);
  });
});
