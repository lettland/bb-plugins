// Class lists follow bb's button component (MIT).
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
/** Used instead of `hint`, never with it: both set the colour, and the compiled CSS would keep the grey. */
export const countOver = "text-xs text-destructive";

const cardBase = "rounded-lg border border-border p-4 flex flex-col gap-4";
export const card = cx(cardBase, "bg-card");
/** A read-only card: `bg-muted` replaces `bg-card`, the two are never joined. */
export const cardMuted = cx(cardBase, "bg-muted");
export const cardTitle = "text-base font-semibold";
export const cardNote = "text-sm text-muted-foreground";

export const badge = "inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs";

export const banner = "rounded-md border border-destructive/50 p-3 text-sm";
export const bannerTitle = "font-medium text-destructive";
export const pre = "rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap";
