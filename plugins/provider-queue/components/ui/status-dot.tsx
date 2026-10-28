import * as React from "react";

import { cn } from "../../lib/utils";

export type StatusTone =
  /** Work is happening right now. */
  | "ongoing"
  /** Finished a turn and needs a human. */
  | "unread";

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
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
  ({ tone, pulse = false, className, ...props }, ref) => (
    <span
      ref={ref}
      data-tone={tone}
      data-pulse={pulse ? "" : undefined}
      className={cn("bb-status-dot", className)}
      aria-hidden={true}
      {...props}
    />
  ),
);
StatusDot.displayName = "StatusDot";

export { StatusDot };
