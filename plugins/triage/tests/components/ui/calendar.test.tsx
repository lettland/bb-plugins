// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CalendarDay } from "react-day-picker";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Calendar, CalendarDayButton } from "@/components/ui/calendar";

afterEach(() => {
  cleanup();
});

const JAN_15_2026 = new Date(2026, 0, 15);
const JAN_20_2026 = new CalendarDay(new Date(2026, 0, 20), JAN_15_2026);

// data-day uses toLocaleDateString, which depends on the runtime locale.
function daySelector(date: Date): string {
  return `[data-day="${date.toLocaleDateString()}"]`;
}

// calendar tests.
describe("Calendar", () => {
  it("renders a single-select month grid, selects a day, and navigates months", () => {
    const onSelect = vi.fn();
    render(
      <Calendar defaultMonth={JAN_15_2026} mode="single" selected={new Date(2026, 0, 20)} onSelect={onSelect} />,
    );
    expect(document.querySelector('[data-slot="calendar"]')).toBeTruthy();
    expect(screen.getByText("January 2026")).toBeTruthy();
    expect(screen.getByText("January 2026").className).toContain("text-sm");

    fireEvent.click(screen.getByRole("button", { name: "Go to the Previous Month" }));
    expect(screen.getByText("December 2025")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to the Next Month" }));
    expect(screen.getByText("January 2026")).toBeTruthy();

    const day = document.querySelector(daySelector(new Date(2026, 0, 20)));
    expect(day?.getAttribute("data-selected-single")).toBe("true");
    fireEvent.click(day!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("marks range selections with start, middle, and end attributes", () => {
    render(
      <Calendar
        defaultMonth={JAN_15_2026}
        mode="range"
        selected={{ from: new Date(2026, 0, 10), to: new Date(2026, 0, 14) }}
      />,
    );
    expect(document.querySelector(daySelector(new Date(2026, 0, 10)))?.getAttribute("data-range-start")).toBe("true");
    expect(document.querySelector(daySelector(new Date(2026, 0, 12)))?.getAttribute("data-range-middle")).toBe("true");
    expect(document.querySelector(daySelector(new Date(2026, 0, 14)))?.getAttribute("data-range-end")).toBe("true");
    expect(document.querySelector(daySelector(new Date(2026, 0, 12)))?.getAttribute("data-selected-single")).toBe("false");
  });

  it("renders dropdown-month captions with their select and the down chevron, plus week numbers", () => {
    render(
      <Calendar
        defaultMonth={JAN_15_2026}
        captionLayout="dropdown-months"
        showWeekNumber
        startMonth={new Date(2025, 0, 1)}
        endMonth={new Date(2027, 11, 31)}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Choose the Month" })).toBeTruthy();
    // The dropdown caption label carries the wide variant styling with its chevron.
    expect(document.querySelector('[class*="rounded-md pl-2 pr-1"]')).toBeTruthy();
    expect(document.querySelector("td .flex.items-center.justify-center")).toBeTruthy();
  });

  it("renders dropdown-year captions with their select", () => {
    render(
      <Calendar
        defaultMonth={JAN_15_2026}
        captionLayout="dropdown-years"
        startMonth={new Date(2025, 0, 1)}
        endMonth={new Date(2027, 11, 31)}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Choose the Year" })).toBeTruthy();
  });

  it("shows outside days and honours hidden days when asked", () => {
    render(<Calendar defaultMonth={JAN_15_2026} showOutsideDays={false} />);
    // Jan 2026 starts on a Thursday; without outside days the trailing
    // December days of the first week row are not rendered.
    expect(document.querySelector(daySelector(new Date(2025, 11, 28)))).toBeNull();
  });

  it("styles the plain caption label without the dropdown paddings", () => {
    render(<Calendar defaultMonth={JAN_15_2026} />);
    expect(screen.getByText("January 2026").className).not.toContain("pl-2");
    expect(screen.getByRole("button", { name: "Go to the Previous Month" })).toBeTruthy();
  });
});

// calendar-day-button tests.
describe("CalendarDayButton", () => {
  it("focuses itself when the focused modifier is set", () => {
    render(
      <CalendarDayButton day={JAN_20_2026} modifiers={{ focused: true }} className="extra-day">
        20
      </CalendarDayButton>,
    );
    const button = screen.getByText("20");
    expect(document.activeElement).toBe(button);
    expect(button.className).toContain("extra-day");
    expect(button.getAttribute("data-day")).toBe(new Date(2026, 0, 20).toLocaleDateString());
  });

  it("flags the selected-single modifier only when no range edges apply", () => {
    render(
      <CalendarDayButton
        day={JAN_20_2026}
        modifiers={{ selected: true, range_start: false, range_end: false, range_middle: false }}
      >
        20
      </CalendarDayButton>,
    );
    const button = screen.getByText("20");
    expect(button.getAttribute("data-selected-single")).toBe("true");
    expect(button.getAttribute("data-range-start")).toBe("false");
  });

  it("suppresses the selected-single flag for range edges", () => {
    render(
      <CalendarDayButton day={JAN_20_2026} modifiers={{ selected: true, range_start: true }}>
        20
      </CalendarDayButton>,
    );
    const button = screen.getByText("20");
    expect(button.getAttribute("data-selected-single")).toBe("false");
    expect(button.getAttribute("data-range-start")).toBe("true");
  });

  it("renders unselected days without any selection flags", () => {
    render(
      <CalendarDayButton
        day={JAN_20_2026}
        modifiers={{ selected: false, range_start: false, range_end: false, range_middle: false }}
      >
        20
      </CalendarDayButton>,
    );
    const button = screen.getByText("20");
    expect(button.getAttribute("data-selected-single")).toBe("false");
    expect(button.getAttribute("data-range-middle")).toBe("false");
    expect(button.textContent).toBe("20");
  });
});
