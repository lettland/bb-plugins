import * as React from "react";

import { cn } from "../../lib/utils";
import { Icon, type IconName } from "./icon";

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
  /** Optional leading glyph; hidden on narrow segments to protect the label. */
  icon?: IconName;
  /** Optional trailing tally, rendered dimmer than the label. */
  count?: number;
  /** Optional accessible description for the segment. */
  hint?: string;
}

export interface SegmentedProps<Value extends string> {
  value: Value;
  options: readonly SegmentedOption<Value>[];
  onValueChange: (value: Value) => void;
  "aria-label": string;
  size?: "sm" | "default";
  className?: string;
}

/**
 * Segmented control in the dim-tab idiom: inactive labels recede, the active
 * one is the only bright thing, and a single indicator slides between them so
 * the eye tracks one object instead of watching two backgrounds cross-fade.
 */
function Segmented<Value extends string>({
  value,
  options,
  onValueChange,
  size = "default",
  className,
  "aria-label": ariaLabel,
}: SegmentedProps<Value>) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = React.useState<{ left: number; width: number } | null>(null);

  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const measure = () => {
      const active = list.querySelector<HTMLElement>('[data-state="active"]');
      if (!active) {
        setIndicator(null);
        return;
      }
      // offsetLeft counts from the border box; the indicator is positioned
      // against the padding box, so the border width has to come back off.
      setIndicator({ left: active.offsetLeft - list.clientLeft, width: active.offsetWidth });
    };

    measure();
    // Fonts and container resizes both move the active segment; re-measure
    // rather than letting the indicator drift away from its label.
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const child of Array.from(list.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [options, value]);

  return (
    // A group of toggle buttons rather than a tablist: these segments filter
    // what is already on screen, and a tablist without a tabpanel misleads
    // assistive technology into looking for one.
    <div
      ref={listRef}
      role="group"
      aria-label={ariaLabel}
      data-size={size}
      className={cn("bb-segmented", className)}
    >
      {indicator ? (
        <span
          aria-hidden="true"
          className="bb-segmented-indicator"
          style={{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }}
        />
      ) : null}
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            title={option.hint}
            data-state={active ? "active" : "inactive"}
            className="bb-segmented-item"
            onClick={() => onValueChange(option.value)}
          >
            {option.icon ? (
              <Icon name={option.icon} className="bb-segmented-icon" aria-hidden="true" />
            ) : null}
            <span className="truncate">{option.label}</span>
            {option.count !== undefined ? (
              <span className="bb-segmented-count tabular-nums">{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export { Segmented };
