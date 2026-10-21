import * as React from "react";

import { cn } from "../../lib/utils";

const shapeClass = {
  block: "rounded-md",
  text: "rounded-[3px]",
  pill: "rounded-full",
  circle: "rounded-full",
} as const;

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Corner treatment. `text` matches a line of copy, `circle` an avatar. */
  shape?: keyof typeof shapeClass;
  /** Stagger index so a group of placeholders breathes as a wave, not a block. */
  delay?: number;
}

/**
 * Low-contrast loading placeholder. The tint is deliberately dimmer than any
 * real surface so a loading board never reads as an empty board.
 */
const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, shape = "block", delay = 0, style, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("bb-skeleton", shapeClass[shape], className)}
      style={delay ? { ...style, animationDelay: `${delay}ms` } : style}
      {...props}
    />
  ),
);
Skeleton.displayName = "Skeleton";

/** A line of placeholder text. `width` accepts any CSS length or percentage. */
function SkeletonLine({
  width = "100%",
  className,
  style,
  ...props
}: SkeletonProps & { width?: string }) {
  return (
    <Skeleton
      shape="text"
      className={cn("h-3", className)}
      style={{ ...style, width }}
      {...props}
    />
  );
}

export { Skeleton, SkeletonLine };
