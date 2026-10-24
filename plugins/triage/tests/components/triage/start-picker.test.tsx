// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import * as React from "react";

import {
  StartPicker,
  formatStartDistance,
  type StartMode,
  type StartPickerProps,
} from "@/components/triage/start-picker";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// pure distance tests.
test("describes immediate and manual starts", () => {
  expect(formatStartDistance("now", "")).toBe("Starts immediately");
  expect(formatStartDistance("manual", "")).toBe("Stays on the board until you run it");
});

test("describes scheduled starts", () => {
  // Pin the clock mid-summer so no DST transition sits inside the ranges.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-01T12:00:00"));
  try {
    expectScheduledDistances();
  } finally {
    vi.useRealTimers();
  }
});

function expectScheduledDistances(): void {
  expect(formatStartDistance("later", "")).toBe("Choose a date and time");
  expect(formatStartDistance("later", "not-a-date")).toBe("Choose a date and time");
  const past = new Date(Date.now() - 60_000);
  expect(formatStartDistance("later", toLocal(past))).toBe("Choose a future time");
  expect(formatStartDistance("later", toLocal(new Date(Date.now() + 45_000)))).toBe(
    "Starts in 1 minute",
  );
  expect(
    formatStartDistance("later", toLocal(new Date(Date.now() + 30 * 60_000 + 15_000))),
  ).toBe("Starts in 30 minutes");
  // The hour and day lines only run from 120 minutes and 48 hours up, so the
  // minute line owns everything under two hours.
  expect(
    formatStartDistance("later", toLocal(new Date(Date.now() + 60 * 60_000 + 15_000))),
  ).toBe("Starts in 60 minutes");
  expect(
    formatStartDistance("later", toLocal(new Date(Date.now() + 90 * 60_000 + 15_000))),
  ).toBe("Starts in 90 minutes");
  expect(
    formatStartDistance("later", toLocal(new Date(Date.now() + 130 * 60_000 + 15_000))),
  ).toBe("Starts in 2 hours");
  expect(
    formatStartDistance("later", toLocal(new Date(Date.now() + 30 * 3_600_000 + 15_000))),
  ).toBe("Starts in 30 hours");
  expect(
    formatStartDistance("later", toLocal(new Date(Date.now() + 24 * 3_600_000 + 15_000))),
  ).toBe("Starts in 24 hours");
  expect(
    formatStartDistance("later", toLocal(new Date(Date.now() + 49 * 3_600_000 + 15_000))),
  ).toBe("Starts in 2 days");
}

function toLocal(date: Date): string {
  // Shift by the target's own UTC offset so the round trip through the local
  // parse survives DST transitions between now and the scheduled instant.
  const shifted = new Date(date);
  shifted.setMinutes(shifted.getMinutes() - shifted.getTimezoneOffset());
  return shifted.toISOString().slice(0, 19);
}

// harness tests.
function Harness(props: Partial<StartPickerProps> = {}) {
  const [mode, setMode] = React.useState<StartMode>(props.mode ?? "now");
  const [scheduledLocal, setScheduledLocal] = React.useState(props.scheduledLocal ?? "");
  return (
    <>
      <span data-testid="mode">{mode}</span>
      <span data-testid="when">{scheduledLocal}</span>
      <StartPicker
        mode={mode}
        scheduledLocal={scheduledLocal}
        onModeChange={setMode}
        onScheduledLocalChange={setScheduledLocal}
        {...props}
      />
    </>
  );
}

function futureLocal(hoursAhead: number): string {
  return toLocal(new Date(Date.now() + hoursAhead * 3_600_000));
}

test("shows the run-now control by default", () => {
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Choose when this task starts" });
  expect(trigger.textContent).toContain("Run now");
  expect(trigger.querySelector("[data-icon='Clock']")).toBeTruthy();
  expect(screen.getByTestId("mode").textContent).toBe("now");
  expect(document.querySelector(".triage-schedule-popover")).toBe(null);
});

test("shows the manual control", () => {
  render(<Harness mode="manual" />);
  const trigger = screen.getByRole("button", { name: "Choose when this task starts" });
  expect(trigger.textContent).toContain("Keep on board");
  expect(trigger.querySelector("[data-icon='Pause']")).toBeTruthy();
});

test("flags invalid schedules in the distance line", () => {
  render(<Harness mode="later" scheduledLocal="" />);
  const trigger = screen.getByRole("button", { name: "Choose when this task starts" });
  expect(trigger.textContent).toContain("Pick a time");
  const note = document.querySelector(".triage-schedule-popover, .grid > span") as HTMLElement;
  const distance = screen.getByText("Choose a date and time");
  expect(distance.className).toContain("text-destructive");
});

test("flags past schedules in the distance line", () => {
  render(<Harness mode="later" scheduledLocal={toLocal(new Date(Date.now() - 60_000))} />);
  const distance = screen.getByText("Choose a future time");
  expect(distance.className).toContain("text-destructive");
});

test("keeps a valid schedule quiet in the distance line", () => {
  render(<Harness mode="later" scheduledLocal={futureLocal(3)} />);

  const distance = screen.getByText(/Starts in \d+ hours?/);
  expect(distance.className).not.toContain("text-destructive");
});

test("respects the disabled flag on the trigger", () => {
  render(<Harness disabled />);
  expect(
    (screen.getByRole("button", { name: "Choose when this task starts" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

// scheduling panel tests.
test("switching to a schedule seeds a default time and opens the panel", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Choose when this task starts" }));

  const group = await screen.findByRole("group", { name: "Start behavior" });
  const schedule = Array.from(group.querySelectorAll("button")).find(
    (b) => b.textContent === "Schedule",
  ) as HTMLButtonElement;
  fireEvent.click(schedule);

  await waitFor(() => expect(screen.getByTestId("mode").textContent).toBe("later"));
  expect(screen.getByTestId("when").textContent).not.toBe("");
  expect(await screen.findByRole("group", { name: "Scheduled time" })).toBeTruthy();
  expect(document.querySelector(".triage-schedule-calendar")).toBeTruthy();
});

test("closing the panel via on-board keeps the pick", async () => {
  const initial = futureLocal(5);
  render(<Harness mode="later" scheduledLocal={initial} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose when this task starts" }));
  const group = await screen.findByRole("group", { name: "Start behavior" });
  const onBoard = Array.from(group.querySelectorAll("button")).find(
    (b) => b.textContent === "On board",
  ) as HTMLButtonElement;
  fireEvent.click(onBoard);

  await waitFor(() => {
    expect(screen.queryByRole("group", { name: "Start behavior" })).toBe(null);
  });
  expect(screen.getByTestId("mode").textContent).toBe("manual");
  expect(screen.getByTestId("when").textContent).toBe(initial);
});

test("run-now closes the panel", async () => {
  render(<Harness mode="later" scheduledLocal={futureLocal(5)} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose when this task starts" }));
  const group = await screen.findByRole("group", { name: "Start behavior" });
  const runNow = Array.from(group.querySelectorAll("button")).find(
    (b) => b.textContent === "Run now",
  ) as HTMLButtonElement;
  fireEvent.click(runNow);
  await waitFor(() => {
    expect(screen.queryByRole("group", { name: "Start behavior" })).toBe(null);
  });
  expect(screen.getByTestId("mode").textContent).toBe("now");
});

// preset tests.
test("the presets schedule relative times", async () => {
  // Frozen so the day-boundary assertions (Tonight, Tomorrow) cannot race
  // local midnight between the click and the read.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-01T15:00:00"));
  const initial = futureLocal(5);
  render(<Harness mode="later" scheduledLocal={initial} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose when this task starts" }));
  const inHour = await screen.findByRole("button", { name: "In 1 hour" });
  fireEvent.click(inHour);
  const afterHour = screen.getByTestId("when").textContent as string;
  expect(afterHour).not.toBe(initial);
  const parsedHour = new Date(afterHour).getTime() - Date.now();
  expect(parsedHour).toBeGreaterThan(50 * 60_000);
  expect(parsedHour).toBeLessThan(70 * 60_000);
  expect(screen.getByText(/Starts in/)).toBeTruthy();

  fireEvent.click(await screen.findByRole("button", { name: "Tonight" }));
  const tonight = new Date(screen.getByTestId("when").textContent as string);
  expect(tonight.getHours()).toBe(20);

  fireEvent.click(await screen.findByRole("button", { name: "Tomorrow 9:00" }));
  const tomorrow = new Date(screen.getByTestId("when").textContent as string);
  expect(tomorrow.getHours()).toBe(9);
  expect(tomorrow.getDate()).not.toBe(new Date().getDate());
});

// calendar tests.
test("picking a day keeps the time of day", async () => {
  render(<Harness mode="later" scheduledLocal={futureLocal(5)} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose when this task starts" }));
  const initial = screen.getByTestId("when").textContent as string;
  const before = new Date(initial);

  const calendar = document.querySelector(".triage-schedule-calendar") as HTMLElement;
  const days = Array.from(calendar.querySelectorAll("button")).filter(
    (b) => !b.disabled,
  );
  const target = days[days.length - 1];
  fireEvent.click(target);

  await waitFor(() => {
    expect(screen.getByTestId("when").textContent).not.toBe(initial);
  });
  const after = new Date(screen.getByTestId("when").textContent as string);
  expect(after.getHours()).toBe(before.getHours());
  expect(after.getMinutes()).toBe(before.getMinutes());
});

test("re-picking the selected day keeps everything", async () => {
  const when = futureLocal(5);
  render(<Harness mode="later" scheduledLocal={when} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose when this task starts" }));
  const selected = (await screen.findByText("Local time")).ownerDocument.querySelector(
    ".triage-schedule-calendar [data-selected] button",
  ) as HTMLButtonElement | null;
  expect(selected).toBeTruthy();
  fireEvent.click(selected!);
  expect(screen.getByTestId("when").textContent).toBe(when);
});

test("picking a day without a seed uses the next schedule slot", async () => {
  // Frozen to dodge the month-end edge: on a month's last day after 23:00
  // the slot clock rolls to tomorrow while the picked day stays put.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-01T15:00:00"));
  render(<Harness mode="later" scheduledLocal="" />);
  fireEvent.click(screen.getByRole("button", { name: "Choose when this task starts" }));
  const calendar = (await screen.findByText("Local time")).ownerDocument.querySelector(
    ".triage-schedule-calendar",
  ) as HTMLElement;
  const days = Array.from(calendar.querySelectorAll("button")).filter((b) => !b.disabled);
  fireEvent.click(days[days.length - 1]);
  await waitFor(() => expect(screen.getByTestId("when").textContent).not.toBe(""));
  const picked = new Date(screen.getByTestId("when").textContent as string);
  // The seed is the next 15-minute slot after now + 1h; the picked day owns
  // the date while the slot owns the clock.
  expect(picked.getTime()).toBeGreaterThan(Date.now());
});

test("committing a passed time without a seed keeps the seeded day and flags it past", async () => {
  // Frozen past the committed hour so the case is clock-independent: without
  // a seed the date comes from the nextScheduleTime slot's day (today), so
  // committing 11:00 at 15:00 lands earlier today and stays there.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-01T15:00:00"));
  render(<Harness mode="later" scheduledLocal="" />);
  fireEvent.click(screen.getByRole("button", { name: "Choose when this task starts" }));
  await screen.findByRole("group", { name: "Scheduled time" });
  const hour = screen.getByLabelText("Hour") as HTMLInputElement;
  fireEvent.change(hour, { target: { value: "11" } });
  fireEvent.keyDown(hour, { key: "Enter" });
  await waitFor(() => expect(screen.getByTestId("when").textContent).not.toBe(""));
  const picked = new Date(screen.getByTestId("when").textContent as string);
  // The component keeps the seeded day rather than rolling to tomorrow, so
  // the committed slot is today 11:00 and the picker marks it invalid.
  expect(picked.getHours() % 12).toBe(11);
  expect(picked.getDate()).toBe(1);
  expect(picked.getTime()).toBeLessThan(Date.now());
  // The Harness holds the picker on its initial prop, so probe the committed
  // value directly for the invalid distance line.
  const probe = render(
    <StartPicker
      mode="later"
      scheduledLocal={screen.getByTestId("when").textContent as string}
      onModeChange={() => {}}
      onScheduledLocalChange={() => {}}
    />,
  );
  const distance = within(probe.container).getByText("Choose a future time");
  expect(distance.className).toContain("text-destructive");
});

// time picker tests.
test("committing a new time updates the schedule", async () => {
  render(<Harness mode="later" scheduledLocal={futureLocal(5)} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose when this task starts" }));
  const initial = screen.getByTestId("when").textContent as string;
  const before = new Date(initial);

  const group = await screen.findByRole("group", { name: "Scheduled time" });
  const hour = screen.getByLabelText("Hour") as HTMLInputElement;
  fireEvent.change(hour, { target: { value: "11" } });
  fireEvent.keyDown(hour, { key: "Enter" });

  await waitFor(() => {
    expect(screen.getByTestId("when").textContent).not.toBe(initial);
  });
  const after = new Date(screen.getByTestId("when").textContent as string);
  expect(after.getHours() % 12).toBe(11 % 12);
  expect(after.getMinutes()).toBe(before.getMinutes());
});

test("an invalid time draft resets instead of scheduling", async () => {
  const initial = futureLocal(5);
  render(<Harness mode="later" scheduledLocal={initial} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose when this task starts" }));
  const group = await screen.findByRole("group", { name: "Scheduled time" });
  void group;

  const hour = screen.getByLabelText("Hour") as HTMLInputElement;
  fireEvent.change(hour, { target: { value: "0" } });
  fireEvent.keyDown(hour, { key: "Enter" });
  await act(async () => {});
  expect((screen.getByLabelText("Hour") as HTMLInputElement).value).not.toBe("0");
  expect(screen.getByTestId("when").textContent).toBe(initial);
});

test("shows the scheduled time label inside the panel", async () => {
  render(<Harness mode="later" scheduledLocal={futureLocal(5)} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose when this task starts" }));
  expect(await screen.findByText("Local time")).toBeTruthy();
});
