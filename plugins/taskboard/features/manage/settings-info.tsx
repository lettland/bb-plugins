import { useBbContext, useBbNavigate } from '@get-bb/plugin-sdk/app';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { PANEL_PATH } from '../shared/constants.js';
import { routeToSubPath } from '../shared/route.js';

export function TaskboardSettingsInfo() {
  const navigate = useBbNavigate();
  const { projectId } = useBbContext();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Each BB project has its own tracker connection, filter set, default
        layout, and workflow status order.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          navigate.toPluginPanel(PANEL_PATH, {
            subPath: projectId
              ? routeToSubPath({ kind: 'manage', projectId })
              : 'manage'
          })
        }
      >
        <Icon name="Settings" className="size-4" />
        Open Taskboard project settings
      </Button>
    </div>
  );
}
