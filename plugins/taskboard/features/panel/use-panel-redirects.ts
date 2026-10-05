import { useEffect, useRef } from 'react';
import { useBbNavigate } from '@get-bb/plugin-sdk/app';
import { type TrackerProject } from '../../contract.js';
import {
  contextSelectionToken,
  shouldApplyContextProject
} from '../../project-selection.js';
import { PANEL_PATH } from '../shared/constants.js';
import { routeToSubPath, type TrackerRoute } from '../shared/route.js';
import { storeLastProjectId } from '../shared/storage.js';

function replaceWithProjectRoute(
  navigate: ReturnType<typeof useBbNavigate>,
  kind: 'project' | 'manage',
  projectId: string
): void {
  navigate.toPluginPanel(PANEL_PATH, {
    subPath: routeToSubPath({ kind, projectId }),
    replace: true
  });
}

export function useContextProjectSelection({
  route,
  subPath,
  projects,
  selectionContextProjectId,
  selectionContextThreadId,
  contextTargetProjectId
}: {
  route: TrackerRoute;
  subPath: string;
  projects: readonly TrackerProject[] | undefined;
  selectionContextProjectId: string | null;
  selectionContextThreadId: string | null;
  contextTargetProjectId: string | null;
}) {
  const navigate = useBbNavigate();
  const handledContextSelectionRef = useRef<string | null>(null);

  useEffect(() => {
    if (projects === undefined || !shouldApplyContextProject(route)) return;
    const token = contextSelectionToken(
      selectionContextThreadId,
      selectionContextProjectId,
      contextTargetProjectId
    );
    if (handledContextSelectionRef.current === token) return;
    handledContextSelectionRef.current = token;
    if (contextTargetProjectId === null) return;

    storeLastProjectId(contextTargetProjectId);
    replaceWithProjectRoute(
      navigate,
      route.kind === 'manage' ? 'manage' : 'project',
      contextTargetProjectId
    );
  }, [
    contextTargetProjectId,
    navigate,
    projects,
    selectionContextProjectId,
    selectionContextThreadId,
    subPath
  ]);
}

export function useDefaultProjectRedirects({
  route,
  subPath,
  contextTargetProjectId,
  preferredProjectId
}: {
  route: TrackerRoute;
  subPath: string;
  contextTargetProjectId: string | null;
  preferredProjectId: string | null;
}) {
  const navigate = useBbNavigate();

  useEffect(() => {
    if (
      route.kind !== 'root' ||
      contextTargetProjectId !== null ||
      preferredProjectId === null
    ) {
      return;
    }
    storeLastProjectId(preferredProjectId);
    replaceWithProjectRoute(navigate, 'project', preferredProjectId);
  }, [
    contextTargetProjectId,
    navigate,
    preferredProjectId,
    route.kind
  ]);
  useEffect(() => {
    if (
      route.kind !== 'manage' ||
      route.projectId !== null ||
      contextTargetProjectId !== null ||
      preferredProjectId === null
    ) {
      return;
    }
    replaceWithProjectRoute(navigate, 'manage', preferredProjectId);
  }, [
    contextTargetProjectId,
    navigate,
    preferredProjectId,
    route.kind,
    subPath
  ]);
}
