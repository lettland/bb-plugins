import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import { trackActivity } from "./src/activity.js";
import type { ActivityTracker } from "./src/activity.js";
import type { ErrorKind, PathProblem, WakatimeRpcContract, WakatimeStatus } from "./src/rpc-contract.js";
import { visibleError } from "./src/status.js";

const SOFT_INK = "color-mix(in oklch, var(--ink) 68%, var(--canvas))";

const LOG_HINT = "details are in ~/.wakatime/wakatime.log";

const ERROR_LABELS: Record<ErrorKind, string> = {
  "missing-cli": `wakatime-cli not found or not executable (${LOG_HINT})`,
  auth: `authentication failed; check the API key in ~/.wakatime.cfg (${LOG_HINT})`,
  network: `network error reaching WakaTime (${LOG_HINT})`,
  config: `wakatime-cli rejected its arguments or config; check the categories and ~/.wakatime.cfg (${LOG_HINT})`,
  timeout: `wakatime-cli timed out (${LOG_HINT})`,
  other: `wakatime-cli failed (${LOG_HINT})`,
};

const PROBLEM_LABELS: Record<PathProblem, string> = {
  "not-absolute": "the path is not absolute",
  "not-found": "nothing exists at the path",
  "not-a-file": "the path is not a regular file",
  "not-executable": "the file is not executable",
};

const JOB_LABELS = { heartbeat: "heartbeat", sync: "AI sync" } as const;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Renders nothing: reports real interaction in this window as heartbeats. */
function ActivityOverlay() {
  const rpc = useRpc<WakatimeRpcContract>();
  const { projectId, threadId } = useBbContext();
  const trackerRef = useRef<ActivityTracker | null>(null);

  useEffect(() => {
    const tracker = trackActivity(
      (route) => {
        // A failed heartbeat is not worth surfacing here; the settings section shows server health.
        // Only the ids the view has: the wire format has no undefined.
        const input = {
          ...(route.projectId === null ? {} : { projectId: route.projectId }),
          ...(route.threadId === null ? {} : { threadId: route.threadId }),
        };
        void rpc.call("heartbeat", input).catch(() => undefined);
      },
      { projectId, threadId },
    );
    trackerRef.current = tracker;
    return () => {
      tracker.dispose();
      trackerRef.current = null;
    };
    // The route is applied by the next effect; re-creating on it would drop the throttle.
  }, [rpc]);

  useEffect(() => {
    trackerRef.current?.setRoute({ projectId, threadId });
  }, [projectId, threadId]);

  return null;
}

function StatusPanel() {
  const rpc = useRpc<WakatimeRpcContract>();
  const [status, setStatus] = useState<WakatimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef(0);

  const load = useCallback(async () => {
    const revision = ++revisionRef.current;
    try {
      const result = await rpc.call("status", null);
      if (revision !== revisionRef.current) return;
      setStatus(result);
      setError(null);
    } catch (nextError) {
      if (revision !== revisionRef.current) return;
      setError(describeError(nextError));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      revisionRef.current++;
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  if (status === null) {
    if (error === null) return <p style={{ color: SOFT_INK }}>Loading status…</p>;
    return (
      <div role="alert" style={{ color: "var(--destructive-text)" }}>
        <p>Could not load status: {error}</p>
        <button type="button" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  const { cliPath, lastHeartbeatAt, lastSyncAt, unmatchedExcludes } = status;
  const currentError = visibleError(status);
  const formatTime = (at: number | null) => (at === null ? "none yet" : new Date(at).toLocaleString());
  return (
    <div>
      <dl style={{ margin: 0, display: "grid", gap: 6, fontSize: 12 }}>
        <div>
          <dt style={{ color: SOFT_INK }}>wakatime-cli</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{cliPath}</dd>
        </div>
        <div>
          <dt style={{ color: SOFT_INK }}>Last successful heartbeat</dt>
          <dd style={{ margin: 0 }}>{formatTime(lastHeartbeatAt)}</dd>
        </div>
        <div>
          <dt style={{ color: SOFT_INK }}>Last successful AI sync</dt>
          <dd style={{ margin: 0 }}>{formatTime(lastSyncAt)}</dd>
        </div>
        {currentError === null ? null : (
          <div>
            <dt style={{ color: SOFT_INK }}>
              Last error ({JOB_LABELS[currentError.job]}, {new Date(currentError.at).toLocaleString()})
            </dt>
            <dd style={{ margin: 0, color: "var(--destructive-text)" }}>
              <span role="alert">
                {ERROR_LABELS[currentError.kind]}
                {currentError.problem === undefined ? "" : `: ${PROBLEM_LABELS[currentError.problem]}`}
                {currentError.exitCode === null ? "" : ` (exit ${currentError.exitCode})`}
              </span>
            </dd>
          </div>
        )}
        {unmatchedExcludes.length === 0 ? null : (
          <div>
            <dt style={{ color: SOFT_INK }}>Excluded projects that match no project</dt>
            <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{unmatchedExcludes.join(", ")}</dd>
          </div>
        )}
      </dl>
      <button type="button" style={{ marginTop: 8 }} onClick={() => void load()}>
        Refresh
      </button>
      {error === null ? null : (
        <span role="alert" style={{ marginLeft: 8, fontSize: 12, color: "var(--destructive-text)" }}>
          Could not refresh: {error}
        </span>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "activity", component: ActivityOverlay });
  app.slots.settingsSection({
    id: "status",
    title: "WakaTime status",
    description: "Whether heartbeats are reaching WakaTime from the bb server host.",
    component: StatusPanel,
  });
});
