// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatTime, parseTime, TimePicker } from "@/components/ui/time-picker";

afterEach(() => {
  cleanup();
});

// time-picker parsing tests.
describe("parseTime", () => {
  it("falls back to 9:00 for out-of-range hours", () => {
    expect(parseTime("24:00")).toStrictEqual({ hour: 9, minute: 0, period: "am" });
    expect(parseTime("-1:30")).toStrictEqual({ hour: 9, minute: 30, period: "am" });
    expect(parseTime("nope:15")).toStrictEqual({ hour: 9, minute: 15, period: "am" });
  });

  it("falls back to minute 0 for out-of-range minutes", () => {
    expect(parseTime("08:60")).toStrictEqual({ hour: 8, minute: 0, period: "am" });
    expect(parseTime("08:-3")).toStrictEqual({ hour: 8, minute: 0, period: "am" });
    expect(parseTime("08:xx")).toStrictEqual({ hour: 8, minute: 0, period: "am" });
  });

  it("keeps in-range values and derives the period", () => {
    expect(parseTime("12:00")).toStrictEqual({ hour: 12, minute: 0, period: "pm" });
    expect(parseTime("13:59")).toStrictEqual({ hour: 1, minute: 59, period: "pm" });
    expect(parseTime("00:59")).toStrictEqual({ hour: 12, minute: 59, period: "am" });
  });
});

// time-picker formatting tests.
describe("formatTime", () => {
  it("maps am hours onto the front of the day", () => {
    expect(formatTime({ hour: 1, minute: 0, period: "am" })).toBe("01:00");
    expect(formatTime({ hour: 12, minute: 59, period: "am" })).toBe("00:59");
  });

  it("maps pm hours onto the afternoon", () => {
    expect(formatTime({ hour: 12, minute: 0, period: "pm" })).toBe("12:00");
    expect(formatTime({ hour: 11, minute: 5, period: "pm" })).toBe("23:05");
  });
});

// time-picker tests.
describe("TimePicker", () => {
  function hourField() {
    return screen.getByLabelText("Hour") as HTMLInputElement;
  }
  function minuteField() {
    return screen.getByLabelText("Minute") as HTMLInputElement;
  }

  it("renders the hour, minute, and period parts from the value", () => {
    const onValueChange = vi.fn();
    render(<TimePicker value="09:15" onValueChange={onValueChange} aria-label="Start time" />);
    const group = screen.getByRole("group", { name: "Start time" });
    expect(group.className).toContain("bb-time-picker");
    expect(hourField().value).toBe("9");
    expect(minuteField().value).toBe("15");
    const period = screen.getByRole("group", { name: "Time period" });
    expect(period.querySelector('[data-state="active"]')?.textContent).toBe("AM");
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("marks the group and both fields invalid", () => {
    const onValueChange = vi.fn();
    render(<TimePicker value="09:15" onValueChange={onValueChange} invalid aria-label="End time" />);
    const group = screen.getByRole("group", { name: "End time" });
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(group.getAttribute("data-invalid")).toBe("true");
    expect(hourField().getAttribute("aria-invalid")).toBe("true");
    expect(minuteField().getAttribute("aria-invalid")).toBe("true");
  });

  it("disables both fields", () => {
    const onValueChange = vi.fn();
    render(<TimePicker value="09:15" onValueChange={onValueChange} disabled />);
    expect(hourField().disabled).toBe(true);
    expect(minuteField().disabled).toBe(true);
  });

  it("commits a valid hour on blur and reports 24-hour time", () => {
    const onValueChange = vi.fn();
    render(<TimePicker value="09:15" onValueChange={onValueChange} />);
    fireEvent.change(hourField(), { target: { value: "2" } });
    fireEvent.blur(hourField());
    expect(onValueChange).toHaveBeenCalledWith("02:15");
    expect(hourField().value).toBe("2");
  });

  it("commits a valid minute on blur with zero padding", () => {
    const onValueChange = vi.fn();
    render(<TimePicker value="09:15" onValueChange={onValueChange} />);
    fireEvent.change(minuteField(), { target: { value: "5" } });
    fireEvent.blur(minuteField());
    expect(onValueChange).toHaveBeenCalledWith("09:05");
    expect(minuteField().value).toBe("05");
  });

  it("reverts an out-of-range hour without reporting a change", () => {
    const onValueChange = vi.fn();
    render(<TimePicker value="09:15" onValueChange={onValueChange} />);
    fireEvent.change(hourField(), { target: { value: "25" } });
    fireEvent.blur(hourField());
    expect(onValueChange).not.toHaveBeenCalled();
    expect(hourField().value).toBe("9");
    expect(minuteField().value).toBe("15");
  });

  it("reverts an out-of-range minute without reporting a change", () => {
    const onValueChange = vi.fn();
    render(<TimePicker value="09:15" onValueChange={onValueChange} />);
    fireEvent.change(minuteField(), { target: { value: "61" } });
    fireEvent.blur(minuteField());
    expect(onValueChange).not.toHaveBeenCalled();
    expect(minuteField().value).toBe("15");
  });

  it.each([
    ["2.5", "hour"],
    ["0", "hour"],
    ["13", "hour"],
    ["2.5", "minute"],
    ["-3", "minute"],
  ])("reverts the draft %s typed into the %s field", (draft, field) => {
    const onValueChange = vi.fn();
    render(<TimePicker value="09:15" onValueChange={onValueChange} />);
    const input = field === "hour" ? hourField() : minuteField();
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.blur(input);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(input.value).toBe(field === "hour" ? "9" : "15");
  });

  it("commits on Enter, blurs the field, and ignores other keys", () => {
    const onValueChange = vi.fn();
    render(<TimePicker value="09:15" onValueChange={onValueChange} />);
    fireEvent.change(hourField(), { target: { value: "11" } });
    fireEvent.keyDown(hourField(), { key: "a" });
    expect(onValueChange).not.toHaveBeenCalled();

    fireEvent.keyDown(hourField(), { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("11:15");
    expect(document.activeElement).toBe(document.body);
  });

  it("selects the field contents on focus", () => {
    const onValueChange = vi.fn();
    render(<TimePicker value="09:15" onValueChange={onValueChange} />);
    const hour = hourField();
    const hourSelect = vi.spyOn(hour, "select");
    fireEvent.focus(hour);
    expect(hourSelect).toHaveBeenCalledTimes(1);
    const minute = minuteField();
    const minuteSelect = vi.spyOn(minute, "select");
    fireEvent.focus(minute);
    expect(minuteSelect).toHaveBeenCalledTimes(1);
  });

  it("switches the period through a parent that applies the new value", () => {
    function Controlled() {
      const [value, setValue] = React.useState("09:15");
      return <TimePicker value={value} onValueChange={setValue} />;
    }
    render(<Controlled />);
    const period = () => screen.getByRole("group", { name: "Time period" });
    expect(period().querySelector('[data-state="active"]')?.textContent).toBe("AM");

    fireEvent.click(screen.getByText("PM"));
    expect(period().querySelector('[data-state="active"]')?.textContent).toBe("PM");
    expect(hourField().value).toBe("9");
  });

  it("re-syncs the drafts when the value prop changes", () => {
    const onValueChange = vi.fn();
    const view = render(<TimePicker value="09:15" onValueChange={onValueChange} />);
    view.rerender(<TimePicker value="23:59" onValueChange={onValueChange} />);
    expect(hourField().value).toBe("11");
    expect(minuteField().value).toBe("59");
    expect(screen.getByRole("group", { name: "Time period" }).querySelector('[data-state="active"]')?.textContent).toBe("PM");

    fireEvent.click(screen.getByText("AM"));
    expect(onValueChange).toHaveBeenCalledWith("11:59");
  });
});
