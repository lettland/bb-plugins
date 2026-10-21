import * as React from "react";

import { cn } from "../../lib/utils";

export type StatusTone =
  /** Work is happening right now. */
  | "ongoing"
  /** Waiting to start — queued by hand. */
  | "pending"
  /** Waiting on a clock. */
  | "scheduled"
  /** Finished a turn and needs a human. */
  | "unread"
  /** Reached the end of the line. */
  | "done"
  /** Broke, or was stopped. */
  | "danger"
  | "neutral";

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  /** Announced to screen readers in place of the colour. */
  label?: string;
  size?: "sm" | "default";
  /**
   * Breathe. Reserved for a dot that stands for work happening right now — a
   * legend or a column header is a label, not an event, and must stay still.
   */
  pulse?: boolean;
}

/**
 * The single visual identifier for run state. Colour carries the category and
 * motion carries "right now", so a glance at a column reads without labels.
 */
const StatusDot = React.forwardRef<HTMLSpanElement, StatusDotProps>(
  ({ tone, label, size = "default", pulse = false, className, ...props }, ref) => (
    <span
      ref={ref}
      data-tone={tone}
      data-size={size}
      data-pulse={pulse ? "" : undefined}
      className={cn("bb-status-dot", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...props}
    />
  ),
);
StatusDot.displayName = "StatusDot";

export { StatusDot };
