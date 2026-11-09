import { useEffect, useMemo, useRef, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { ProjectSort } from "../../shared/preferences.js";
import type { ProjectGroupLayoutEntry } from "../model/project-groups.js";
import {
  buildDesiredProjectOrder,
  planProjectMoves,
} from "../model/project-order-sync.js";
import type { SidebarProject } from "../model/use-sidebar-data.js";
import { getErrorStatus } from "../ui/mutation-errors.js";

const SYNC_DEBOUNCE_MS = 1000;
const STALE_ORDER_STATUS = 409;
const SYNC_FAILED_MESSAGE = "Could not sync the project order to bb";

interface UseProjectOrderSyncArgs {
  layout: readonly ProjectGroupLayoutEntry[];
  projects: readonly SidebarProject[];
  projectSort: ProjectSort;
}

function isWindowActive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function useWindowActive(): boolean {
  const [active, setActive] = useState(isWindowActive);
  useEffect(() => {
    const update = () => setActive(isWindowActive());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return active;
}

function describeErrorKind(error: unknown): number | string {
  return (
    getErrorStatus(error) ?? (error instanceof Error ? error.name : "unknown")
  );
}

export function useProjectOrderSync({
  layout,
  projects,
  projectSort,
}: UseProjectOrderSyncArgs): void {
  const sdk = useSdk();
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;
  const active = useWindowActive();
  const [busy, setBusy] = useState(false);
  const [staleRetries, setStaleRetries] = useState(0);
  const attemptedPlanRef = useRef<string | null>(null);
  const staleRetryRef = useRef<{ plan: string | null; used: boolean }>({
    plan: null,
    used: false,
  });
  const moves = useMemo(() => {
    const serverProjectIds = projects
      .filter((project) => !project.isPersonal)
      .map((project) => project.id);
    return planProjectMoves(
      serverProjectIds,
      buildDesiredProjectOrder(layout, serverProjectIds),
    );
  }, [layout, projects]);
  const plan = useMemo(() => JSON.stringify(moves), [moves]);
  const enabled = projectSort !== "activity" && active;

  useEffect(() => {
    if (moves.length === 0) {
      attemptedPlanRef.current = null;
      staleRetryRef.current = { plan: null, used: false };
      return;
    }
    if (!enabled || busy || attemptedPlanRef.current === plan) return;
    const timer = setTimeout(() => {
      attemptedPlanRef.current = plan;
      if (staleRetryRef.current.plan !== plan) {
        staleRetryRef.current = { plan, used: false };
      }
      setBusy(true);
      void (async () => {
        let projectId = "";
        try {
          for (const move of moves) {
            projectId = move.projectId;
            await sdkRef.current.projects.reorder(move);
          }
        } catch (error) {
          if (getErrorStatus(error) !== STALE_ORDER_STATUS) {
            console.warn(
              SYNC_FAILED_MESSAGE,
              projectId,
              describeErrorKind(error),
            );
          } else if (!staleRetryRef.current.used) {
            staleRetryRef.current.used = true;
            attemptedPlanRef.current = null;
            setStaleRetries((count) => count + 1);
          }
        } finally {
          setBusy(false);
        }
      })();
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [busy, enabled, moves, plan, staleRetries]);
}
