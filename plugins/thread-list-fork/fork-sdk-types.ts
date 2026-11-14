import type {
  BbNavigate,
  PluginBrowserBbSdk,
  PluginSidebarThread,
  PluginSidebarThreadIndicator as PublishedPluginSidebarThreadIndicator,
  PluginSidebarThreadsState,
  PluginThreadStatus as PublishedPluginThreadStatus,
} from "@get-bb/plugin-sdk/app";

export type PluginSidebarThreadIndicator =
  | PublishedPluginSidebarThreadIndicator
  | "waiting-for-plan-approval"
  | "waiting-for-answer";

export type ForkThreadStatus = Omit<
  PublishedPluginThreadStatus,
  "indicator"
> & {
  indicator: PluginSidebarThreadIndicator;
};

export interface ForkSidebarSpace {
  id: string;
  name: string;
  brief: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface ForkSpacesArea {
  create(args: { name: string; brief?: string }): Promise<ForkSidebarSpace>;
  update(args: {
    id: string;
    name?: string;
    brief?: string;
    archived?: boolean;
  }): Promise<ForkSidebarSpace>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readThreadSpaceId(thread: PluginSidebarThread): string | null {
  const value: unknown = Reflect.get(thread, "experimental_spaceId");
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSidebarSpace(value: unknown): ForkSidebarSpace | null {
  if (!isRecord(value)) return null;
  const { id, name, brief, directory, createdAt, updatedAt } = value;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof name !== "string" ||
    typeof brief !== "string" ||
    typeof directory !== "string" ||
    typeof createdAt !== "number" ||
    typeof updatedAt !== "number"
  ) {
    return null;
  }
  const archivedAt = typeof value.archivedAt === "number" ? value.archivedAt : null;
  return { id, name, brief, directory, createdAt, updatedAt, archivedAt };
}

const NO_SPACES: readonly ForkSidebarSpace[] = [];
const readSpacesByRawList = new WeakMap<
  readonly unknown[],
  readonly ForkSidebarSpace[]
>();

export function readSidebarSpaces(
  state: PluginSidebarThreadsState,
): readonly ForkSidebarSpace[] {
  const value: unknown = Reflect.get(state, "experimental_spaces");
  if (!Array.isArray(value)) return NO_SPACES;
  const cached = readSpacesByRawList.get(value);
  if (cached !== undefined) return cached;
  const spaces = value.flatMap((entry: unknown) => {
    const space = readSidebarSpace(entry);
    return space === null ? [] : [space];
  });
  const result = spaces.length === 0 ? NO_SPACES : spaces;
  readSpacesByRawList.set(value, result);
  return result;
}

export function readSpacesArea(sdk: PluginBrowserBbSdk): ForkSpacesArea | null {
  const area: unknown = Reflect.get(sdk, "experimental_spaces");
  if (
    (typeof area !== "object" && typeof area !== "function") ||
    area === null
  ) {
    return null;
  }
  const hasMethods =
    typeof Reflect.get(area, "create") === "function" &&
    typeof Reflect.get(area, "update") === "function";
  return hasMethods ? (area as ForkSpacesArea) : null;
}

export function openComposeInSpace(
  navigate: BbNavigate,
  options: { projectId: string; spaceId: string },
): void {
  const args: NonNullable<Parameters<BbNavigate["toCompose"]>[0]> & {
    placement: {
      sectionId: string | null;
      pinned: boolean;
      experimental_spaceId: string;
    };
  } = {
    projectId: options.projectId,
    placement: {
      sectionId: null,
      pinned: false,
      experimental_spaceId: options.spaceId,
    },
    focusPrompt: true,
  };
  navigate.toCompose(args);
}
