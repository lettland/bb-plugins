// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

afterEach(() => {
  cleanup();
});

interface SelectSceneProps {
  position?: "popper" | "item-aligned";
}

function SelectScene({ position = "popper" }: SelectSceneProps) {
  const [value, setValue] = React.useState("");
  return (
    <Select value={value} onValueChange={setValue}>
      <SelectTrigger aria-label="Provider" className="w-72">
        <SelectValue placeholder="Choose a provider" />
      </SelectTrigger>
      <SelectContent position={position}>
        <SelectGroup>
          <SelectLabel>Managed</SelectLabel>
          <SelectItem value="alpha">Alpha</SelectItem>
          <SelectItem value="beta">Beta</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectItem value="gamma" disabled>
          Gamma
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

// select tests.
describe("Select", () => {
  it("renders the trigger with its value and chevron", () => {
    render(<SelectScene />);
    const trigger = screen.getByRole("combobox", { name: "Provider" });
    expect(trigger.className).toContain("w-72");
    expect(trigger.querySelector('[data-icon="ChevronDown"]')).toBeTruthy();
    expect(screen.getByText("Choose a provider")).toBeTruthy();
  });

  it("opens the content with groups, label, separator, scroll buttons, and selects an item", () => {
    render(<SelectScene />);
    expect(screen.queryByText("Alpha")).toBeNull();

    fireEvent.click(screen.getByRole("combobox", { name: "Provider" }));
    expect(screen.getByText("Managed").className).toContain("font-semibold");
    expect(document.querySelector('[class*="bg-border"]')).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();

    fireEvent.click(screen.getByText("Beta"));
    expect(screen.getByRole("combobox", { name: "Provider" }).textContent).toContain("Beta");
  });

  it("renders the popper positioning classes for popper selects", () => {
    render(<SelectScene />);
    fireEvent.click(screen.getByRole("combobox", { name: "Provider" }));
    const content = document.querySelector('[role="listbox"]');
    expect(content?.className).toContain("data-[side=bottom]:translate-y-1");
  });

  it("renders without popper positioning classes for item-aligned selects", () => {
    render(<SelectScene position="item-aligned" />);
    fireEvent.click(screen.getByRole("combobox", { name: "Provider" }));
    const content = document.querySelector('[role="listbox"]');
    expect(content?.className).not.toContain("translate-y-1");
  });
});
