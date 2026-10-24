// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Icon } from "@/components/ui/icon";
import { ICON_NAMES } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

afterEach(() => {
  cleanup();
});

// input tests.
describe("Input", () => {
  it("renders a text input that reports typed values", () => {
    const onChange = vi.fn();
    render(<Input aria-label="Title" onChange={onChange} />);
    const input = screen.getByLabelText("Title") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("hello");
  });

  it("passes the type through, keeps the coarse-pointer sizing, and merges classes", () => {
    render(<Input type="number" className="w-40" aria-label="Count" />);
    const input = screen.getByLabelText("Count") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("number");
    expect(input.className).toContain("h-9");
    expect(input.className).toContain("w-40");
  });
});

// textarea tests.
describe("Textarea", () => {
  it("renders a textarea that reports typed values and merges classes", () => {
    const onChange = vi.fn();
    render(<Textarea aria-label="Notes" className="min-h-0" onChange={onChange} />);
    const area = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    expect(area.tagName).toBe("TEXTAREA");
    // tailwind-merge resolves the caller's min-height against the default.
    expect(area.className).toContain("min-h-0");
    expect(area.className).not.toContain("min-h-[60px]");
    expect(area.className).toContain("placeholder:text-muted-foreground");
    fireEvent.change(area, { target: { value: "line" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(area.value).toBe("line");
  });
});

// icon tests.
describe("Icon", () => {
  it("renders the mapped svg and forwards aria attributes", () => {
    render(<Icon name="Check" className="size-4" aria-hidden="true" />);
    const svg = document.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("data-icon")).toBe("Check");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toContain("size-4");
  });

  it("renders a labelled icon without aria-hidden", () => {
    render(<Icon name="AlertTriangle" aria-label="Warning" />);
    const svg = document.querySelector("svg");
    expect(svg?.getAttribute("aria-label")).toBe("Warning");
    expect(svg?.getAttribute("aria-hidden")).toBeNull();
  });

  it("exposes every mapped icon name", () => {
    expect(ICON_NAMES.length).toBeGreaterThan(100);
    expect(ICON_NAMES).toContain("Check");
    expect(ICON_NAMES).toContain("X");
  });
});
