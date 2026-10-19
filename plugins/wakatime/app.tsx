import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import { trackActivity } from "./src/activity.js";
import type { ActivityTracker } from "./src/activity.js";
import type { WakatimeRpcContract, WakatimeStatus } from "./src/rpc-contract.js";

const SOFT_INK = "color-mix(in oklch, var(--ink) 68%, var(--canvas))";

const ERROR_LABELS: Record<NonNullable<WakatimeStatus["lastError"]>["kind"], string> = {
  "missing-cli": "wakatime-cli not found or not executable",
  auth: "authentication failed; check the API key in ~/.wakatime.cfg",
  network: "network error reaching WakaTime",
  timeout: "wakatime-cli timed out",
  other: "wakatime-cli failed",
};

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
        void rpc
          .call("heartbeat", { projectId: route.projectId ?? undefined, threadId: route.threadId ?? undefined })
          .catch(() => undefined);
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

  const { cliPath, lastSuccessAt, lastError, unmatchedExcludes } = status;
  // An error older than the last success has been recovered from.
  const currentError = lastError !== null && (lastSuccessAt === null || lastError.at > lastSuccessAt) ? lastError : null;
  return (
    <dl style={{ margin: 0, display: "grid", gap: 6, fontSize: 12 }}>
      <div>
        <dt style={{ color: SOFT_INK }}>wakatime-cli</dt>
        <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{cliPath ?? "not used yet"}</dd>
      </div>
      <div>
        <dt style={{ color: SOFT_INK }}>Last successful heartbeat</dt>
        <dd style={{ margin: 0 }}>{lastSuccessAt === null ? "none yet" : new Date(lastSuccessAt).toLocaleString()}</dd>
      </div>
      {currentError === null ? null : (
        <div role="alert" style={{ color: "var(--destructive-text)" }}>
          <dt>Last error ({new Date(currentError.at).toLocaleString()})</dt>
          <dd style={{ margin: 0 }}>
            {ERROR_LABELS[currentError.kind]}
            {currentError.exitCode === null ? "" : ` (exit ${currentError.exitCode})`}
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
