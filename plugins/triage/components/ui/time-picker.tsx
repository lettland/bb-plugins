import * as React from "react";

import { Input } from "./input";
import { Segmented } from "./segmented";

type Period = "am" | "pm";

const PERIOD_OPTIONS = [
  { value: "am" as const, label: "AM" },
  { value: "pm" as const, label: "PM" },
];

interface TimeParts {
  hour: number;
  minute: number;
  period: Period;
}

function parseTime(value: string): TimeParts {
  const [rawHour, rawMinute] = value.split(":").map(Number);
  const hour24 = Number.isInteger(rawHour) && rawHour >= 0 && rawHour < 24 ? rawHour : 9;
  const minute = Number.isInteger(rawMinute) && rawMinute >= 0 && rawMinute < 60 ? rawMinute : 0;
  return {
    hour: hour24 % 12 || 12,
    minute,
    period: hour24 >= 12 ? "pm" : "am",
  };
}

function formatTime({ hour, minute, period }: TimeParts): string {
  const hour24 = hour % 12 + (period === "pm" ? 12 : 0);
  return String(hour24).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
}

export interface TimePickerProps {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  "aria-label"?: string;
}

/** Shadcn-composed time field with predictable controls on every browser. */
function TimePicker({
  value,
  onValueChange,
  disabled,
  invalid,
  "aria-label": ariaLabel = "Time",
}: TimePickerProps) {
  const parts = parseTime(value);
  const [hourDraft, setHourDraft] = React.useState(String(parts.hour));
  const [minuteDraft, setMinuteDraft] = React.useState(String(parts.minute).padStart(2, "0"));

  React.useEffect(() => {
    const next = parseTime(value);
    setHourDraft(String(next.hour));
    setMinuteDraft(String(next.minute).padStart(2, "0"));
  }, [value]);

  const commit = (period = parts.period) => {
    const hour = Number(hourDraft);
    const minute = Number(minuteDraft);
    if (
      !Number.isInteger(hour) ||
      hour < 1 ||
      hour > 12 ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    ) {
      setHourDraft(String(parts.hour));
      setMinuteDraft(String(parts.minute).padStart(2, "0"));
      return;
    }
    setHourDraft(String(hour));
    setMinuteDraft(String(minute).padStart(2, "0"));
    onValueChange(formatTime({ hour, minute, period }));
  };

  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commit();
    event.currentTarget.blur();
  };

  return (
    <div
      className="bb-time-picker"
      role="group"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      data-invalid={invalid || undefined}
    >
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        max={12}
        value={hourDraft}
        disabled={disabled}
        aria-label="Hour"
        aria-invalid={invalid || undefined}
        className="bb-time-picker-field"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setHourDraft(event.target.value)}
        onBlur={() => commit()}
        onKeyDown={commitOnEnter}
      />
      <span className="bb-time-picker-separator" aria-hidden="true">:</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={59}
        step={5}
        value={minuteDraft}
        disabled={disabled}
        aria-label="Minute"
        aria-invalid={invalid || undefined}
        className="bb-time-picker-field"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setMinuteDraft(event.target.value)}
        onBlur={() => commit()}
        onKeyDown={commitOnEnter}
      />
      <Segmented
        aria-label="Time period"
        size="sm"
        value={parts.period}
        options={PERIOD_OPTIONS}
        onValueChange={(period) => commit(period)}
        className="bb-time-picker-period"
      />
    </div>
  );
}

export { TimePicker, formatTime, parseTime };
