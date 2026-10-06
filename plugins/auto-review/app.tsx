import { useCallback, useEffect, useId, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { AutoReviewRpcContract, ProjectSetting } from "./src/rpc-contract.js";

const SOFT_INK = "color-mix(in oklch, var(--ink) 68%, var(--canvas))";

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
  onToggle: (project: ProjectSetting, next: boolean) => void;
}) {
  const { project, pending, error, onToggle } = props;
  const base = useId();
  const switchId = `${base}-switch`;
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
        {error === undefined ? null : (
          <div role="alert" style={{ fontSize: 12, color: "var(--destructive-text)" }}>
            {error}
          </div>
        )}
      </div>
    </li>
  );
}

function ProjectAutoApprove() {
  const rpc = useRpc<AutoReviewRpcContract>();
  const [projects, setProjects] = useState<ProjectSetting[] | null>(null);
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
      setError(null);
    } catch (nextError) {
      if (revision !== revisionRef.current) return;
      setProjects(null);
      setError(describeError(nextError));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const toggle = async (project: ProjectSetting, next: boolean) => {
    setPending((current) => ({ ...current, [project.id]: true }));
    setRowErrors((current) => without(current, project.id));
    try {
      const stored = await rpc.call("setAutoApprovePlans", {
        projectId: project.id,
        autoApprovePlans: next,
      });
      // Supersede any list fetch started before this write landed.
      revisionRef.current++;
      setProjects(
        (current) =>
          current?.map((row) =>
            row.id === stored.projectId
              ? { ...row, autoApprovePlans: stored.autoApprovePlans }
              : row,
          ) ?? null,
      );
    } catch (nextError) {
      setRowErrors((current) => ({ ...current, [project.id]: describeError(nextError) }));
      await load();
    } finally {
      setPending((current) => without(current, project.id));
    }
  };

  if (error !== null) {
    return (
      <div role="alert" style={{ color: "var(--destructive-text)" }}>
        <p>Could not load projects: {error}</p>
        <button type="button" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (projects === null) return <p style={{ color: SOFT_INK }}>Loading projects…</p>;
  if (projects.length === 0) return <p style={{ color: SOFT_INK }}>No projects.</p>;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {projects.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          pending={pending[project.id] === true}
          error={rowErrors[project.id]}
          onToggle={(row, next) => void toggle(row, next)}
        />
      ))}
    </ul>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "project-auto-approve",
    title: "Plan auto-approve",
    description:
      "Off by default. When on for a project, a plan auto-review has reviewed is approved for you: the agent starts implementing without waiting for your approval.",
    component: ProjectAutoApprove,
  });
});
