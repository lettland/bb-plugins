import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Clock01Icon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "../../lib/utils";

// The map mirrors triage's icon.tsx, trimmed to the glyphs this panel draws.
const ICON_MAP = {
  Clock: Clock01Icon,
  ChevronUp: ArrowUp01Icon,
  ChevronDown: ArrowDown01Icon,
  X: Cancel01Icon,
  SlidersHorizontal: SlidersHorizontalIcon,
} as const satisfies Record<string, IconSvgElement>;

export type IconName = keyof typeof ICON_MAP;

export interface IconProps {
  name: IconName;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export function Icon({
  name,
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps) {
  return (
    <HugeiconsIcon
      icon={ICON_MAP[name]}
      className={cn(className)}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      data-icon={name}
    />
  );
}
