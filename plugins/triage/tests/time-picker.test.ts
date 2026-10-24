import { expect, test } from "vitest";

import { formatTime, parseTime } from "../components/ui/time-picker.tsx";

test("parseTime converts midnight and noon to 12-hour time", () => {
  expect(parseTime("00:05")).toStrictEqual({ hour: 12, minute: 5, period: "am" });
  expect(parseTime("12:30")).toStrictEqual({ hour: 12, minute: 30, period: "pm" });
});

test("parseTime converts morning and evening hours", () => {
  expect(parseTime("09:15")).toStrictEqual({ hour: 9, minute: 15, period: "am" });
  expect(parseTime("21:45")).toStrictEqual({ hour: 9, minute: 45, period: "pm" });
});

test("formatTime converts 12-hour values to zero-padded 24-hour time", () => {
  expect(formatTime({ hour: 12, minute: 5, period: "am" })).toBe("00:05");
  expect(formatTime({ hour: 12, minute: 30, period: "pm" })).toBe("12:30");
  expect(formatTime({ hour: 9, minute: 7, period: "pm" })).toBe("21:07");
});
