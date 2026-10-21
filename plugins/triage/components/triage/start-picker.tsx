import * as React from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Icon } from "@/components/ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { TimePicker } from "@/components/ui/time-picker";
import { localDateAt, nextScheduleTime, toDatetimeLocal } from "@/lib/triage-format";

export type StartMode = "now" | "later" | "manual";

const MODE_OPTIONS = [
  { value: "now" as const, label: "Run now" },
  { value: "later" as const, label: "Schedule" },
  { value: "manual" as const, label: "On board" },
];

function formatLocalScheduled(value: string): string {
  if (!value) return "Pick a time";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatStartDistance(mode: StartMode, scheduledLocal: string): string {
  if (mode === "now") return "Starts immediately";
  if (mode === "manual") return "Stays on the board until you run it";
  const timestamp = new Date(scheduledLocal).getTime();
  if (!Number.isFinite(timestamp)) return "Choose a date and time";
  const delta = timestamp - Date.now();
  if (delta <= 0) return "Choose a future time";
  const minutes = Math.max(1, Math.round(delta / 60_000));
  if (minutes < 120) return `Starts in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Starts in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `Starts in ${days} ${days === 1 ? "day" : "days"}`;
}

export interface StartPickerProps {
  mode: StartMode;
  scheduledLocal: string;
  onModeChange: (mode: StartMode) => void;
  onScheduledLocalChange: (value: string) => void;
  disabled?: boolean;
}

/** One control for "when does this run": now, on a clock, or by hand later. */
function StartPicker({
  mode,
  scheduledLocal,
  onModeChange,
  onScheduledLocalChange,
  disabled,
}: StartPickerProps) {
  const [open, setOpen] = React.useState(false);
  const scheduledDate = scheduledLocal ? new Date(scheduledLocal) : undefined;
  const scheduledTime = scheduledDate
    ? `${String(scheduledDate.getHours()).padStart(2, "0")}:${String(scheduledDate.getMinutes()).padStart(2, "0")}`
    : "09:00";
  const scheduleInvalid =
    mode === "later" &&
    (!scheduledDate ||
      !Number.isFinite(scheduledDate.getTime()) ||
      scheduledDate.getTime() <= Date.now());

  const selectMode = (nextMode: StartMode) => {
    onModeChange(nextMode);
    if (nextMode === "later" && !scheduledLocal) {
      onScheduledLocalChange(toDatetimeLocal(nextScheduleTime()));
    }
    if (nextMode !== "later") setOpen(false);
  };

  const selectScheduledDay = (day: Date | undefined) => {
    if (!day) return;
    const next = scheduledDate ?? new Date(nextScheduleTime());
    next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
    onScheduledLocalChange(toDatetimeLocal(next.getTime()));
  };

  const selectScheduledTime = (value: string) => {
    const [hours, minutes] = value.split(":").map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return;
    const next = scheduledDate ?? new Date(nextScheduleTime());
    next.setHours(hours, minutes, 0, 0);
    onScheduledLocalChange(toDatetimeLocal(next.getTime()));
  };

  return (
    <div className="grid min-w-0 gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            disabled={disabled}
            className="h-9 w-full justify-start gap-2 px-3 font-normal"
            aria-label="Choose when this task starts"
            aria-expanded={open}
          >
            <Icon
              name={mode === "manual" ? "Pause" : mode === "later" ? "Calendar" : "Clock"}
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            {mode === "now" ? (
              <span>Run now</span>
            ) : mode === "manual" ? (
              <span>Keep on board</span>
            ) : (
              <span className="truncate">{formatLocalScheduled(scheduledLocal)}</span>
            )}
            <Icon
              name="ChevronDown"
              className="ml-auto size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          avoidCollisions={false}
          collisionPadding={12}
          sideOffset={8}
          className="triage-schedule-popover w-[340px] p-3"
          mobileTitle="Choose a start time"
        >
          <Segmented
            aria-label="Start behavior"
            value={mode}
            options={MODE_OPTIONS}
            onValueChange={selectMode}
            className="w-full [&_.bb-segmented-item]:flex-1"
          />
          {mode === "later" ? (
            <div className="triage-schedule-panel">
              <Calendar
                mode="single"
                defaultMonth={scheduledDate}
                fixedWeeks
                selected={scheduledDate}
                onSelect={selectScheduledDay}
                disabled={{ before: new Date(new Date().setHours(0, 0, 0, 0)) }}
                className="triage-schedule-calendar mx-auto p-0"
                classNames={{
                  month: "flex w-full flex-col gap-3",
                  month_grid: "w-full border-collapse",
                  weekdays: "grid grid-cols-7",
                  weekday:
                    "flex h-8 items-center justify-center text-[11px] font-medium text-muted-foreground",
                  week: "grid grid-cols-7",
                  day: "relative flex size-10 items-center justify-center p-0 text-center",
                  outside: "text-muted-foreground/45",
                  disabled: "text-muted-foreground/30",
                  today: "text-foreground",
                }}
              />
              <div className="triage-schedule-time">
                <div className="triage-schedule-time-label">
                  <span>Time</span>
                  <span>Local time</span>
                </div>
                <TimePicker
                  value={scheduledTime}
                  onValueChange={selectScheduledTime}
                  aria-label="Scheduled time"
                  invalid={scheduleInvalid}
                />
              </div>
              <div className="triage-schedule-presets">
                {[
                  { label: "In 1 hour", at: Date.now() + 3_600_000 },
                  { label: "Tonight", at: localDateAt(20, 0, 0) },
                  { label: "Tomorrow 9:00", at: localDateAt(9, 0, 1) },
                ].map((preset) => (
                  <Button
                    key={preset.label}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 flex-1 px-2 text-[11px]"
                    onClick={() => onScheduledLocalChange(toDatetimeLocal(preset.at))}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>

            </div>
          ) : null}
        </PopoverContent>
      </Popover>
      <span
        className={
          scheduleInvalid
            ? "text-right text-xs font-normal text-destructive"
            : "text-right text-xs font-normal text-muted-foreground"
        }
      >
        {formatStartDistance(mode, scheduledLocal)}
      </span>
    </div>
  );
}

export { StartPicker };
