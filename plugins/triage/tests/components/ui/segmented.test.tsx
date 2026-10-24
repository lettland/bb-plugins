// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Segmented } from "@/components/ui/segmented";

afterEach(() => {
  cleanup();
});

// segmented tests.
describe("Segmented", () => {
  const options = [
    { value: "all", label: "All", count: 12 },
    { value: "mine", label: "Mine", icon: "UserRound" as const, hint: "Assigned to you" },
    { value: "done", label: "Done" },
  ];

  it("renders one pressed button per option and reports clicks", () => {
    const onValueChange = vi.fn();
    render(
      <Segmented aria-label="Filter" value="all" options={options} onValueChange={onValueChange} />,
    );
    const group = screen.getByRole("group", { name: "Filter" });
    expect(group.getAttribute("data-size")).toBe("default");
    const segments = Array.from(group.querySelectorAll<HTMLButtonElement>(".bb-segmented-item"));
    expect(segments).toHaveLength(3);
    const [, mine, done] = segments;
    expect(group.querySelector('[data-state="active"] .truncate')?.textContent).toBe("All");
    expect(segments[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(mine!.getAttribute("aria-pressed")).toBe("false");
    expect(segments[0]!.querySelector(".bb-segmented-count")?.textContent).toBe("12");
    expect(mine!.querySelector("svg")).toBeTruthy();
    expect(mine!.getAttribute("title")).toBe("Assigned to you");
    expect(done!.getAttribute("title")).toBeNull();
    expect(done!.querySelector("svg")).toBeNull();
    expect(done!.querySelector(".bb-segmented-count")).toBeNull();

    fireEvent.click(done!);
    expect(onValueChange).toHaveBeenCalledWith("done");
  });

  it("takes the small size variant", () => {
    render(
      <Segmented aria-label="Size" size="sm" value="all" options={options} onValueChange={vi.fn()} className="w-64" />,
    );
    expect(screen.getByRole("group", { name: "Size" }).getAttribute("data-size")).toBe("sm");
    expect(screen.getByRole("group", { name: "Size" }).className).toContain("w-64");
  });

  it("positions a sliding indicator over the active segment and re-measures on change", () => {
    function Board() {
      const [value, setValue] = React.useState("all");
      return (
        <Segmented aria-label="Board" value={value} options={options} onValueChange={setValue} />
      );
    }
    render(<Board />);
    const group = screen.getByRole("group", { name: "Board" });
    // jsdom lays out at zero, so the measured indicator carries the zero
    // offset but proves the measure ran and the span mounted.
    let indicator = group.querySelector<HTMLElement>(".bb-segmented-indicator");
    expect(indicator).toBeTruthy();
    expect(indicator!.getAttribute("aria-hidden")).toBe("true");
    expect(indicator!.style.transform).toBe("translateX(0px)");
    expect(indicator!.style.width).toBe("0px");

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });
    indicator = group.querySelector<HTMLElement>(".bb-segmented-indicator");
    expect(indicator).toBeTruthy();
    expect(group.querySelector('[data-state="active"]')?.textContent).toBe("Done");
  });

  it("renders no indicator when the value matches no option", () => {
    render(
      <Segmented aria-label="Empty" value="ghost" options={options} onValueChange={vi.fn()} />,
    );
    expect(screen.getByRole("group", { name: "Empty" }).querySelector(".bb-segmented-indicator")).toBeNull();
    expect(document.querySelectorAll('[data-state="active"]')).toHaveLength(0);
  });
});
