import {
  type PluginNavPanelProps,
  useBbContext,
  useBbNavigate
} from '@get-bb/plugin-sdk/app';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { parseTrackerRoute, routeToSubPath } from '../shared/route.js';
import { loadLastProjectId } from '../shared/storage.js';
import {
  DirectCreateIssueAction
} from '../create-issue/create-issue-actions.js';
import { PANEL_PATH } from '../shared/constants.js';

export function ManageHeaderAction({ subPath }: PluginNavPanelProps) {
  const route = parseTrackerRoute(subPath);
  const { projectId: contextProjectId } = useBbContext();
  const navigate = useBbNavigate();
  const routeProjectId =
    route.kind === 'project' || route.kind === 'item'
      ? route.projectId
      : route.kind === 'manage'
        ? route.projectId
        : null;
  const projectId = routeProjectId ?? contextProjectId ?? loadLastProjectId();
  const showCreate = route.kind === 'root' || route.kind === 'project';

  return (
    <div className="flex items-center gap-1.5">
      {showCreate ? (
        <DirectCreateIssueAction projectId={projectId} variant="labeled" />
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          navigate.toPluginPanel(PANEL_PATH, {
            subPath: projectId
              ? routeToSubPath({ kind: 'manage', projectId })
              : 'manage'
          })
        }
      >
        <Icon name="Settings" className="size-4" />
        Manage
      </Button>
    </div>
  );
}
