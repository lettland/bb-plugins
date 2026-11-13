export type SidebarSectionId =
  | "pinned"
  | "threads"
  | `project:${string}`
  | `section:${string}`
  | `machine:${string}`
  | `space:${string}`;
export type CollapsibleSidebarSectionId = "pinned" | "threads";
