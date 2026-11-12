import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  Markdown,
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginPendingInteractionProps, PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import {
  PLAN_APPROVAL_FEEDBACK_MAX,
  PLAN_APPROVAL_RENDERER,
  PLAN_TRUNCATED_NOTICE,
  PLAN_UNAVAILABLE_NOTICE,
  planApprovalPayloadSchema,
} from "./src/plan-approval-form.js";
import type { AutoReviewRpcContract, ProjectSetting, ThreadReview } from "./src/rpc-contract.js";

type ReviewOverride = ProjectSetting["reviewOverride"];

const SOFT_INK = "color-mix(in oklch, var(--ink) 68%, var(--canvas))";
const PLAN_BOX_BORDER = "color-mix(in oklch, var(--ink) 16%, var(--canvas))";
const BUTTON_BASE =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const PRIMARY_BUTTON = `${BUTTON_BASE} bg-foreground text-background hover:bg-foreground/90`;
const OUTLINE_BUTTON = `${BUTTON_BASE} border border-input bg-transparent hover:bg-state-hover hover:text-foreground`;
const GHOST_BUTTON = `${BUTTON_BASE} hover:bg-state-hover hover:text-foreground`;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function ProjectRow(props: {
  project: ProjectSetting;
  pending: boolean;
  error: string | undefined;
  globalEnabled: boolean;
  onToggle: (project: ProjectSetting, next: boolean) => void;
  onReview: (project: ProjectSetting, next: ReviewOverride) => void;
}) {
  const { project, pending, error, globalEnabled, onToggle, onReview } = props;
  const base = useId();
  const switchId = `${base}-switch`;
  const reviewId = `${base}-review`;
  const detailId = `${base}-detail`;
  return (
    <li
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "8px 0",
        borderTop: "1px solid color-mix(in oklch, var(--ink) 11%, var(--canvas))",
      }}
    >
      <input
        id={switchId}
        type="checkbox"
        role="switch"
        checked={project.autoApprovePlans}
        disabled={pending}
        aria-describedby={detailId}
        onChange={(event) => onToggle(project, event.target.checked)}
        style={{ marginTop: 3 }}
      />
      <div style={{ minWidth: 0 }}>
        <label htmlFor={switchId} style={{ color: "var(--ink)", fontWeight: 500 }}>
          {project.name}
        </label>
        <div id={detailId} style={{ fontSize: 12, color: SOFT_INK }}>
          <span>{project.id}</span>
          {project.reviewActive ? null : (
            <div>auto-review is off for this project, so this has no effect</div>
          )}
        </div>
        <div style={{ fontSize: 12, marginTop: 4 }}>
          <label htmlFor={reviewId} style={{ color: SOFT_INK }}>
            Auto-review
          </label>{" "}
          <select
            id={reviewId}
            value={project.reviewOverride}
            disabled={pending}
            onChange={(event) => onReview(project, event.target.value as ReviewOverride)}
          >
            <option value="default">Default (global: {globalEnabled ? "on" : "off"})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </div>
        {error === undefined ? null : (
          <div role="alert" style={{ fontSize: 12, color: "var(--destructive-text)" }}>
            {error}
          </div>
        )}
      </div>
    </li>
  );
}

function LoadError(props: { error: string; onRetry: () => void }) {
  return (
    <div role="alert" style={{ color: "var(--destructive-text)" }}>
      <p>Could not load projects: {props.error}</p>
      <button type="button" onClick={props.onRetry}>
        Retry
      </button>
    </div>
  );
}

function ProjectAutoApprove() {
  const rpc = useRpc<AutoReviewRpcContract>();
  const [projects, setProjects] = useState<ProjectSetting[] | null>(null);
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, true>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const revisionRef = useRef(0);

  const load = useCallback(async () => {
    const revision = ++revisionRef.current;
    try {
      const result = await rpc.call("listProjectSettings", null);
      if (revision !== revisionRef.current) return;
      setProjects(result.projects);
      setGlobalEnabled(result.globalEnabled);
      setRowErrors({});
      setError(null);
    } catch (nextError) {
      if (revision !== revisionRef.current) return;
      // Keep the last good list; only a first load has nothing to show instead.
      setError(describeError(nextError));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const write = async <T extends { projectId: string }>(
    project: ProjectSetting,
    call: () => Promise<T>,
    apply: (row: ProjectSetting, stored: T) => ProjectSetting,
  ) => {
    setPending((current) => ({ ...current, [project.id]: true }));
    setRowErrors((current) => without(current, project.id));
    try {
      const stored = await call();
      // Supersede any list fetch started before this write landed.
      revisionRef.current++;
      setProjects(
        (current) =>
          current?.map((row) => (row.id === stored.projectId ? apply(row, stored) : row))
          /* v8 ignore start -- @preserve projects only changes from null to a loaded list (see load), and the controls render only from that list, so current is never null here. */
          ?? null,
          /* v8 ignore stop */
      );
    } catch (nextError) {
      // Re-read first: a successful load clears row errors, so the failure
      // is set after it or it would vanish at once.
      await load();
      setRowErrors((current) => ({ ...current, [project.id]: describeError(nextError) }));
    } finally {
      setPending((current) => without(current, project.id));
    }
  };

  const toggle = (project: ProjectSetting, next: boolean) =>
    write(
      project,
      () => rpc.call("setAutoApprovePlans", { projectId: project.id, autoApprovePlans: next }),
      (row, stored) => ({ ...row, autoApprovePlans: stored.autoApprovePlans }),
    );

  const setReview = (project: ProjectSetting, review: ReviewOverride) =>
    write(
      project,
      () => rpc.call("setProjectReview", { projectId: project.id, review }),
      (row, stored) => ({
        ...row,
        reviewOverride: stored.reviewOverride,
        reviewActive: stored.reviewActive,
      }),
    );

  if (projects === null) {
    if (error === null) return <p style={{ color: SOFT_INK }}>Loading projects…</p>;
    return <LoadError error={error} onRetry={() => void load()} />;
  }
  if (projects.length === 0 && error === null) {
    return <p style={{ color: SOFT_INK }}>No projects.</p>;
  }
  return (
    <>
      {error === null ? null : <LoadError error={error} onRetry={() => void load()} />}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {projects.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            pending={pending[project.id] === true}
            error={rowErrors[project.id]}
            globalEnabled={globalEnabled}
            onToggle={(row, next) => void toggle(row, next)}
            onReview={(row, next) => void setReview(row, next)}
          />
        ))}
      </ul>
    </>
  );
}

type ReviewStatus = Exclude<ThreadReview["status"], "none">;

const STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: "Review pending",
  committed: "Committed",
  merged: "Merged",
  uncommitted: "Left uncommitted",
  blocked: "Blocked",
  "no-changes": "No changes",
  "not-reported": "Review not reported",
  stopped: "Review stopped",
  unavailable: "Review unavailable",
  incomplete: "Review incomplete",
};

const DESTRUCTIVE_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  "blocked",
  "not-reported",
  "unavailable",
  "incomplete",
]);

// The plugin itself records these; every other outcome is the review agent's claim.
const PLUGIN_RECORDED_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  "pending",
  "not-reported",
  "stopped",
  "unavailable",
]);

// Any other status can sit beside an incident from a previous review.
const INCIDENT_IS_CURRENT: ReadonlySet<ReviewStatus> = new Set([
  "not-reported",
  "unavailable",
  "incomplete",
]);

function statusColor(status: ReviewStatus): string {
  if (DESTRUCTIVE_STATUSES.has(status)) return "var(--destructive-text)";
  return status === "committed" || status === "merged" ? "var(--ink)" : SOFT_INK;
}

// Mirrors `threadReviewChannel` in src/state.ts, which app code can't import
// without pulling in the server's dependencies.
function reviewChannel(threadId: string): string {
  return `auto-review:thread:${threadId}`;
}

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function useThreadReview(threadId: string): ThreadReview | null {
  const rpc = useRpc<AutoReviewRpcContract>();
  const connection = useRealtimeConnectionState();
  const [review, setReview] = useState<ThreadReview | null>(null);
  const revisionRef = useRef(0);
  const previousConnectionRef = useRef(connection);

  const load = useCallback(async () => {
    const revision = ++revisionRef.current;
    try {
      const result = await rpc.call("threadReview", { threadId });
      if (revision === revisionRef.current) setReview(result);
    } catch {
      // A badge that can't load is simply absent; nothing here is worth a toast.
      if (revision === revisionRef.current) setReview(null);
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setReview(null);
    void load();
    return () => {
      revisionRef.current++;
    };
  }, [load]);

  useRealtime(reviewChannel(threadId), () => void load());

  useEffect(() => {
    // Publishes missed while disconnected aren't replayed, so re-read on reconnect.
    const previous = previousConnectionRef.current;
    previousConnectionRef.current = connection;
    if (connection === "connected" && previous !== "connected") void load();
  }, [connection, load]);

  return review;
}

function useDismiss(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  buttonRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape belongs to whatever else has focus (a composer, another popover).
      const focused = document.activeElement;
      if (focused !== document.body && !(focused instanceof Node && rootRef.current?.contains(focused))) {
        return;
      }
      onClose();
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, rootRef, buttonRef, onClose]);
}

function openSuffixOf(openCount: number): string {
  return openCount > 0 ? ` · ${openCount} open` : "";
}

const POPOVER_WIDTH = 280;
const POPOVER_MARGIN = 8;

function ReviewPopover(props: {
  id: string;
  top: number;
  right: number;
  threadId: string;
  status: ReviewStatus;
  review: ThreadReview;
}) {
  const { id, top, right, threadId, status, review } = props;
  const { at, openCount, reRaisedCount, lastIncident } = review;
  return (
    <div
      id={id}
      role="region"
      aria-label="Auto-review details"
      style={{
        position: "fixed",
        top: top + 4,
        right,
        zIndex: 50,
        width: POPOVER_WIDTH,
        maxWidth: "calc(100vw - 16px)",
        padding: 12,
        borderRadius: 8,
        border: "1px solid color-mix(in oklch, var(--ink) 11%, var(--canvas))",
        background: "var(--canvas)",
        color: "var(--ink)",
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        overflowWrap: "anywhere",
      }}
    >
      <div style={{ fontWeight: 500, color: statusColor(status) }}>
        {STATUS_LABELS[status]}
        {openSuffixOf(openCount)}
      </div>
      {at === null ? null : <div style={{ color: SOFT_INK }}>{new Date(at).toLocaleString()}</div>}
      {PLUGIN_RECORDED_STATUSES.has(status) ? null : (
        <div style={{ color: SOFT_INK }}>
          Reported by the review agent, not verified against git.
        </div>
      )}
      {lastIncident === null ? null : (
        <div>
          {INCIDENT_IS_CURRENT.has(status) ? "Incident" : "Earlier incident"} (
          {new Date(lastIncident.at).toLocaleString()}): {lastIncident.kind}:{" "}
          {lastIncident.detail}
        </div>
      )}
      {reRaisedCount > 0 ? <div>{reRaisedCount} re-raised</div> : null}
      <div style={{ color: SOFT_INK }}>Details: bb auto-review findings {threadId}</div>
    </div>
  );
}

function ReviewBadge(props: PluginThreadHeaderActionProps) {
  const { threadId, isCompactViewport } = props;
  const review = useThreadReview(threadId);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [popoverAnchor, setPopoverAnchor] = useState({ top: 0, right: 8 });
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => setOpen(false), [threadId]);

  useEffect(() => {
    if (isCompactViewport) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [isCompactViewport]);

  useDismiss(open, rootRef, buttonRef, close);

  if (review === null || review.status === "none") return null;

  const { status, at, openCount } = review;
  const label = STATUS_LABELS[status];
  const color = statusColor(status);
  const source = PLUGIN_RECORDED_STATUSES.has(status) ? "" : " (agent-reported)";
  const ariaLabel = `Auto-review${source}: ${label}${openCount > 0 ? `, ${openCount} open` : ""}`;
  // The time of a pending review is the previous one's, so it is not shown.
  const showTime = !isCompactViewport && status !== "pending" && at !== null;

  const toggle = () => {
    if (!open) {
      // Fixed positioning lets the popover escape the header row's clipping;
      // its right edge follows the badge so it opens beside it in split
      // layouts, clamped so a badge in a narrow left pane does not push it off-screen.
      const rect = buttonRef.current?.getBoundingClientRect();
      const fromBadge =
        window.innerWidth -
        (rect?.right ??
          // v8 ignore start -- @preserve toggle runs only from the badge button's own onClick (line 428), so buttonRef.current is set and rect is defined.
          window.innerWidth - POPOVER_MARGIN
          // v8 ignore stop
        );
      setPopoverAnchor({
        top:
          rect?.bottom ??
          // v8 ignore start -- @preserve toggle runs only from the badge button's own onClick (line 428), so buttonRef.current is set and rect is defined.
          0,
        // v8 ignore stop
        right: Math.max(
          POPOVER_MARGIN,
          Math.min(fromBadge, window.innerWidth - POPOVER_WIDTH - POPOVER_MARGIN),
        ),
      });
      setNow(Date.now());
    }
    setOpen(!open);
  };

  return (
    <span ref={rootRef} style={{ display: "inline-flex", alignItems: "center" }}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={toggle}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 28,
          minWidth: 28,
          justifyContent: "center",
          padding: isCompactViewport ? 0 : "0 8px",
          border: "none",
          borderRadius: 6,
          background: "transparent",
          color,
          fontSize: 12,
          whiteSpace: "nowrap",
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
          }}
        />
        {isCompactViewport ? null : (
          <span>
            {label}
            {openSuffixOf(openCount)}
            {showTime ? (
              <span style={{ color: SOFT_INK }}>{` · ${relativeTime(at, now)}`}</span>
            ) : null}
          </span>
        )}
      </button>
      {open ? (
        <ReviewPopover
          id={popoverId}
          top={popoverAnchor.top}
          right={popoverAnchor.right}
          threadId={threadId}
          status={status}
          review={review}
        />
      ) : null}
    </span>
  );
}

/**
 * The plan approval form `PresentPlan` opens. Approve and Request changes
 * submit the shapes `parsePlanApprovalValue` reads; Cancel postpones the
 * decision. The form shows the plan text (rendered by the host's `Markdown`,
 * the chat renderer, in a bounded scroll box) above the path, so the user
 * approves what they can read; a plan this host could not read shows a notice
 * and the path only. The composer is hidden while a form is open, so Cancel is
 * the visible way out and Request changes needs feedback typed here. A payload that does not parse shows only Cancel.
 */
function PlanApproval(props: PluginPendingInteractionProps) {
  const { interaction, submit, cancel } = props;
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feedbackId = useId();
  const payload = planApprovalPayloadSchema.safeParse(interaction.payload);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (nextError) {
      setError(describeError(nextError));
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {payload.success ? (
        <>
          <div style={{ color: "var(--ink)", fontWeight: 500 }}>Approve this plan?</div>
          {payload.data.planText === null ? null : (
            <div
              role="region"
              aria-label="Plan text"
              tabIndex={0}
              style={{
                maxHeight: "min(40vh, 320px)",
                overflow: "auto",
                border: `1px solid ${PLAN_BOX_BORDER}`,
                borderRadius: 6,
                padding: 8,
              }}
            >
              <Markdown content={payload.data.planText} />
            </div>
          )}
          {payload.data.planText === null ? (
            <div style={{ fontSize: 12, color: SOFT_INK }}>{PLAN_UNAVAILABLE_NOTICE}</div>
          ) : null}
          {payload.data.truncated ? <div style={{ fontSize: 12, color: SOFT_INK }}>{PLAN_TRUNCATED_NOTICE}</div> : null}
          <div style={{ fontSize: 12, color: SOFT_INK }}>
            <div>{payload.data.planFilePath}</div>
            <div>
              {payload.data.reviewed
                ? "auto-review completed its review of this plan."
                : "auto-review could not confirm that its review of this plan completed."}
            </div>
          </div>
          <label htmlFor={feedbackId} style={{ fontSize: 12, color: SOFT_INK }}>
            Feedback (required for Request changes)
          </label>
          <textarea
            id={feedbackId}
            value={feedback}
            maxLength={PLAN_APPROVAL_FEEDBACK_MAX}
            disabled={busy}
            rows={3}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </>
      ) : (
        <div role="alert" style={{ color: "var(--destructive-text)" }}>
          This plan approval form could not be read. Cancel it and ask the agent to present the plan again.
        </div>
      )}
      {error === null ? null : (
        <div role="alert" style={{ fontSize: 12, color: "var(--destructive-text)" }}>
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        {payload.success ? (
          <>
            <button type="button" className={PRIMARY_BUTTON} disabled={busy} onClick={() => void run(() => submit({ approved: true }))}>
              Approve
            </button>
            <button
              type="button"
              className={OUTLINE_BUTTON}
              disabled={busy || feedback.trim() === ""}
              onClick={() => void run(() => submit({ approved: false, feedback }))}
            >
              Request changes
            </button>
          </>
        ) : null}
        <button type="button" className={GHOST_BUTTON} disabled={busy} onClick={() => void run(cancel)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "project-auto-approve",
    title: "Per-project settings",
    description:
      "Auto-review: Default follows the global Enabled switch; On or Off overrides it for that project. Plan auto-approve: off by default. When on for a project, a plan auto-review has reviewed is approved for you: the agent starts implementing without waiting for your approval.",
    component: ProjectAutoApprove,
  });
  app.slots.experimental_threadHeaderAction({
    id: "review-status",
    title: "Auto-review",
    component: ReviewBadge,
  });
  app.slots.pendingInteraction({ id: PLAN_APPROVAL_RENDERER, component: PlanApproval });
});
