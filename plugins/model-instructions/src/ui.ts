// Class lists modelled on bb's button component (MIT).
// Rule: no call site combines two classes that set the same CSS property. `cx` only joins, it resolves no conflicts.

export const cx = (...parts: string[]): string => parts.join(" ");

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const buttonDefaultSize = "h-9 px-4 text-sm";
const buttonSmallSize = "h-8 px-3 text-xs";

/** Default size: Save, Discard changes, Retry, Keep the rules saved here, every Add. */
export const button = {
  primary: cx(buttonBase, buttonDefaultSize, "bg-foreground text-background hover:bg-foreground/90"),
  outline: cx(buttonBase, buttonDefaultSize, "border border-input bg-transparent hover:bg-state-hover"),
};

/** Small size: Remove, Move up, Move down, Duplicate, Delete. */
export const buttonSm = {
  ghost: cx(buttonBase, buttonSmallSize, "hover:bg-state-hover"),
  destructive: cx(buttonBase, buttonSmallSize, "bg-destructive text-destructive-foreground hover:bg-destructive/90"),
};

const inputBase =
  "w-full rounded-md border border-input bg-transparent px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
export const input = cx("h-9", inputBase);
export const textarea = cx(inputBase, "min-h-32 py-2 font-mono resize-y");

export const field = "flex flex-col gap-1.5";
export const label = "text-sm font-medium";
export const hint = "text-xs text-muted-foreground";
/** The red hint text: used instead of `hint`, never with it. Both set the colour, and the compiled CSS would keep the grey. */
export const errorHint = "text-xs text-destructive";

export const card = "rounded-lg border border-border bg-card p-4 flex flex-col gap-4";
/** A read-only row: no call site joins it with `card`, so their padding and background never conflict. */
export const cardMuted = "rounded-lg border border-border bg-muted p-3 flex flex-col gap-1";
export const cardTitle = "text-base font-semibold";
export const cardNote = "text-sm text-muted-foreground";

export const badge = "inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs";
/** The Remove button inside a chip: smaller than `buttonSm`, so the chip stays one line high. */
export const chipButton =
  "inline-flex items-center rounded-sm px-1 text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export const banner = "rounded-md border border-destructive/50 p-3 text-sm";
export const bannerTitle = "font-medium text-destructive";
export const pre = "rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap overflow-auto";
