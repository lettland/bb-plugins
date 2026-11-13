import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { toast } from "sonner";
import {
  experimental_THREAD_ACTION_GROUPS,
  experimental_useSidebarThreads,
  type PluginBrowserBbSdk,
  type PluginThreadActionRegistration,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import {
  readSidebarSpaces,
  readThreadSpaceId,
  updateThreadSpace,
} from "../../fork-sdk-types.js";
import { sidebarThreadLifecyclesAtom } from "../preferences/atoms.js";
import { getMutationErrorMessage } from "../ui/mutation-errors.js";
import { selectedRoots } from "./moveThreadAction.js";

interface MoveToSpaceData {
  spaces: readonly { id: string; name: string }[];
  spaceIdByThreadId: Readonly<Record<string, string>>;
  spaceWorkspaceThreadIds: readonly string[];
}

const SPACE_WORKSPACE_PROVIDER_ID = "space-workspace";

const NO_SPACE_CHOICE_ID = "no-space";

export function useMoveToSpaceData(): MoveToSpaceData | null {
  const lifecycles = useAtomValue(sidebarThreadLifecyclesAtom);
  const state = experimental_useSidebarThreads({
    experimental_lifecycles: lifecycles,
  });
  const spaces = readSidebarSpaces(state);
  const spaceIdByThreadId: Record<string, string> = {};
  const spaceWorkspaceThreadIds: string[] = [];
  for (const thread of state.threads) {
    const spaceId = readThreadSpaceId(thread);
    if (spaceId !== null) spaceIdByThreadId[thread.id] = spaceId;
    if (thread.environment?.providerId === SPACE_WORKSPACE_PROVIDER_ID) {
      spaceWorkspaceThreadIds.push(thread.id);
    }
  }
  const key =
    spaces.length === 0
      ? ""
      : JSON.stringify({
          spaces: [...spaces]
            .sort(
              (left, right) =>
                left.name.localeCompare(right.name) ||
                left.id.localeCompare(right.id),
            )
            .map((space) => ({ id: space.id, name: space.name })),
          spaceIdByThreadId,
          spaceWorkspaceThreadIds,
        });
  return useMemo(
    () => (key === "" ? null : (JSON.parse(key) as MoveToSpaceData)),
    [key],
  );
}

function choicesFor(
  data: MoveToSpaceData,
  currentSpaceIds: readonly (string | null)[],
) {
  const isCurrent = (spaceId: string | null) =>
    currentSpaceIds.length > 0 &&
    currentSpaceIds.every((current) => current === spaceId);
  const items = data.spaces.map((space) => ({
    id: space.id,
    label: space.name,
    selected: isCurrent(space.id),
    disabled: isCurrent(space.id),
  }));
  if (currentSpaceIds.some((current) => current !== null)) {
    items.push({
      id: NO_SPACE_CHOICE_ID,
      label: "No Space",
      selected: false,
      disabled: false,
    });
  }
  return { items };
}

function destinationSpaceId(
  data: MoveToSpaceData,
  value: string | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === NO_SPACE_CHOICE_ID) return null;
  return data.spaces.some((space) => space.id === value) ? value : undefined;
}

function reportMoveFailure(error: unknown, fallback: string): void {
  toast.error(getMutationErrorMessage({ error, fallbackMessage: fallback }));
}

function staysInSpace(
  data: MoveToSpaceData,
  thread: PluginThreadActionTarget,
): boolean {
  return data.spaceWorkspaceThreadIds.includes(thread.id);
}

function currentSpaceId(
  data: MoveToSpaceData,
  thread: PluginThreadActionTarget,
): string | null {
  return data.spaceIdByThreadId[thread.id] ?? null;
}

async function moveRoots(
  sdk: PluginBrowserBbSdk,
  roots: readonly PluginThreadActionTarget[],
  data: MoveToSpaceData,
  spaceId: string | null,
): Promise<void> {
  const results = await Promise.allSettled(
    roots
      .filter((thread) => currentSpaceId(data, thread) !== spaceId)
      .map((thread) => updateThreadSpace(sdk, thread.id, spaceId)),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    reportMoveFailure(failure.reason, "Failed to move threads.");
  }
}

export const moveToSpaceAction: PluginThreadActionRegistration<MoveToSpaceData | null> =
  {
    id: "moveToSpace",
    title: "Move to Space…",
    icon: "Folder02",
    group: experimental_THREAD_ACTION_GROUPS.organize,
    order: 51,
    useData: useMoveToSpaceData,
    item: ({ thread, data, sdk }) => {
      if (
        data === null ||
        thread.parentThreadId !== null ||
        thread.archivedAt !== null ||
        staysInSpace(data, thread)
      ) {
        return null;
      }
      return {
        label: "Move to Space…",
        icon: "Folder02",
        choices: choicesFor(data, [currentSpaceId(data, thread)]),
        run: ({ value }) => {
          const spaceId = destinationSpaceId(data, value);
          if (spaceId === undefined) return;
          if (currentSpaceId(data, thread) === spaceId) return;
          void updateThreadSpace(sdk, thread.id, spaceId).catch(
            (error: unknown) =>
              reportMoveFailure(error, "Failed to move thread."),
          );
        },
      };
    },
    experimental_bulkItem: ({ threads, data, sdk }) => {
      if (data === null) return null;
      const movable = threads.filter((thread) => !staysInSpace(data, thread));
      if (movable.length === 0) return null;
      const skipped = threads.length - movable.length;
      return {
        label: "Move to Space…",
        icon: "Folder02",
        choices: choicesFor(
          data,
          movable
            .filter((thread) => thread.parentThreadId === null)
            .map((thread) => currentSpaceId(data, thread)),
        ),
        run: async ({ value }) => {
          const spaceId = destinationSpaceId(data, value);
          if (spaceId === undefined) return;
          if (skipped > 0) {
            toast.info(
              `${skipped} ${skipped === 1 ? "thread" : "threads"} skipped. Threads without a project stay in their Space.`,
            );
          }
          const roots = await selectedRoots(sdk, movable).catch(() => null);
          if (roots === null) {
            toast.error("Failed to move threads.");
            return;
          }
          await moveRoots(sdk, roots, data, spaceId);
        },
      };
    },
  };
