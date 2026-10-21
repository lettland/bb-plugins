import { useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";

import { StatusDot } from "@/components/ui/status-dot";
import { requestOpenTask, useTriage } from "@/lib/triage-store";

import { ManageStagesDialog } from "./manage-stages-dialog";
import { NotificationCenter } from "./notification-center";

/**
 * Rendered by the host in the panel's title bar. The bar was empty space; the
 * two board-wide controls that are not about a single card live here, next to
 * a connection light that only speaks up when something is wrong.
 */
function TriageHeaderActions() {
  const { snapshot, rpc, refresh } = useTriage();
  const connection = useRealtimeConnectionState();
  const connected = connection === "connected";

  if (!snapshot) return null;

  return (
    <div className="triage-header-actions">
      <span
        className="triage-connection"
        data-connected={connected ? "" : undefined}
        title={connected ? "Live updates connected" : "Reconnecting to live updates"}
      >
        <StatusDot
          tone={connected ? "done" : "scheduled"}
          size="sm"
          label={connected ? "Live" : "Reconnecting"}
        />
        <span className="triage-connection-label">{connected ? "Live" : "Reconnecting"}</span>
      </span>
      <NotificationCenter
        notifications={snapshot.notifications}
        tasks={snapshot.tasks}
        unreadCount={snapshot.unreadCount}
        onSelect={requestOpenTask}
        onMarkRead={async (ids) => {
          await rpc.call("markNotificationsRead", { ids });
          await refresh();
        }}
        onDelete={async (ids) => {
          await rpc.call("deleteNotifications", { ids });
          await refresh();
        }}
      />
      <ManageStagesDialog stages={snapshot.stages} rpc={rpc} onChanged={refresh} />
    </div>
  );
}

export { TriageHeaderActions };
