import assert from "node:assert/strict";
import { test } from "node:test";

import { formatTime, parseTime } from "../components/ui/time-picker.tsx";

test("parseTime converts midnight and noon to 12-hour time", () => {
  assert.deepEqual(parseTime("00:05"), { hour: 12, minute: 5, period: "am" });
  assert.deepEqual(parseTime("12:30"), { hour: 12, minute: 30, period: "pm" });
});

test("parseTime converts morning and evening hours", () => {
  assert.deepEqual(parseTime("09:15"), { hour: 9, minute: 15, period: "am" });
  assert.deepEqual(parseTime("21:45"), { hour: 9, minute: 45, period: "pm" });
});

test("formatTime converts 12-hour values to zero-padded 24-hour time", () => {
  assert.equal(formatTime({ hour: 12, minute: 5, period: "am" }), "00:05");
  assert.equal(formatTime({ hour: 12, minute: 30, period: "pm" }), "12:30");
  assert.equal(formatTime({ hour: 9, minute: 7, period: "pm" }), "21:07");
});
