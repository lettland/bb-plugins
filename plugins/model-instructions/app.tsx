import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { ConfigState, ModelInstructionsRpcContract, RawConfig } from "./rpc-contract";
import { previewLength } from "./src/vars";

const SOFT_INK = "color-mix(in oklch, var(--ink) 68%, var(--canvas))";
const RULE = "1px solid color-mix(in oklch, var(--ink) 11%, var(--canvas))";
const DESTRUCTIVE = "var(--destructive-text)";
// bb's limit for one thread's instructions; the server checks the same number.
const LIMIT = 4096;
const IGNORED_NOTE = "Ignored: a profile scope with this name comes from profiles.json";
const PROFILE_NOTE = "Claude profile — edit ~/.bb/model-instructions/profiles.json";
const NOT_CHECKABLE_PREFIX = "budget not checkable yet";
const NOT_CHECKABLE_HINT = "bb is still loading the provider and project lists; try again in a moment.";
const DUPLICATE_NOTE = "This name is already used above; rename one of them.";
const LEGACY_FIX = "Fix it, save it to a file and run bb model-instructions import <file>, or dismiss it.";

type RawRule = RawConfig["rules"][number];
type Threads = RawRule["threads"];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface VarRow {
  key: number;
  name: string;
  text: string;
}

interface ScopeRow {
  key: number;
  name: string;
  paths: string[];
}

/** One rule card. `scope` and `skills` hold every entry, checked names and globs alike, in stored order. */
interface RuleRow {
  key: number;
  name: string;
  provider: string;
  model: string;
  threads: Threads;
  project: string[];
  skipProjects: string[];
  skipTitles: string[];
  scope: string[];
  skills: string[];
  instructions: string;
}

interface Draft {
  vars: VarRow[];
  scopes: ScopeRow[];
  rules: RuleRow[];
}

/** The card at index i keeps its key across a load or save, so the inputs are not remounted and focus stays. */
function fromConfig(config: RawConfig, previous: Draft, nextKey: () => number): Draft {
  return {
    vars: Object.entries(config.vars).map(([name, text], index) => ({
      key: previous.vars[index]?.key ?? nextKey(),
      name,
      text,
    })),
    scopes: config.scopes.map((scope, index) => ({
      key: previous.scopes[index]?.key ?? nextKey(),
      name: scope.name,
      paths: scope.paths,
    })),
    rules: config.rules.map((rule, index) => ({
      key: previous.rules[index]?.key ?? nextKey(),
      name: rule.name ?? "",
      provider: rule.provider ?? "",
      model: rule.model ?? "",
      threads: rule.threads,
      project: rule.project ?? [],
      skipProjects: rule.skipProjects ?? [],
      skipTitles: rule.skipTitles ?? [],
      scope: rule.scope ?? [],
      skills: rule.skills ?? [],
      instructions: rule.instructions ?? "",
    })),
  };
}

function trimmedList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

/** An empty field is left out of the payload: the schema rejects "" and [] for these. */
function textOrUndefined(value: string): string | undefined {
  const text = value.trim();
  return text === "" ? undefined : text;
}

function listOrUndefined(values: string[]): string[] | undefined {
  const list = trimmedList(values);
  return list.length === 0 ? undefined : list;
}

function ruleToPayload(rule: RuleRow): RawRule {
  const fields = {
    name: textOrUndefined(rule.name),
    provider: textOrUndefined(rule.provider),
    model: textOrUndefined(rule.model),
    project: listOrUndefined(rule.project),
    skipProjects: listOrUndefined(rule.skipProjects),
    skipTitles: listOrUndefined(rule.skipTitles),
    scope: listOrUndefined(rule.scope),
    skills: listOrUndefined(rule.skills),
    threads: rule.threads,
    // The server trims before it expands, so the text goes as typed.
    instructions: rule.instructions.trim() === "" ? undefined : rule.instructions,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as RawRule;
}

/** What Save sends. A var row with neither a name nor a text is left out. */
function toPayload(draft: Draft): RawConfig {
  return {
    vars: Object.fromEntries(
      draft.vars
        .filter((row) => row.name.trim() !== "" || row.text.trim() !== "")
        .map((row) => [row.name.trim(), row.text]),
    ),
    scopes: draft.scopes.map((scope) => ({ name: scope.name.trim(), paths: trimmedList(scope.paths) })),
    rules: draft.rules.map(ruleToPayload),
  };
}

/** Keys of the rows (that Save would send) whose trimmed name an earlier row already has. */
function duplicateVarKeys(rows: VarRow[]): Set<number> {
  const seen = new Set<string>();
  const duplicates = new Set<number>();
  for (const row of rows) {
    if (row.name.trim() === "" && row.text.trim() === "") continue;
    const name = row.name.trim();
    if (seen.has(name)) duplicates.add(row.key);
    seen.add(name);
  }
  return duplicates;
}

function sameDrafts(left: Draft, right: Draft): boolean {
  return JSON.stringify(toPayload(left)) === JSON.stringify(toPayload(right));
}

/** Any difference a user made, including empty rows and spaces; keys are not compared. */
function sameRawDrafts(left: Draft, right: Draft): boolean {
  const raw = (draft: Draft) =>
    JSON.stringify({
      vars: draft.vars.map(({ name, text }) => ({ name, text })),
      scopes: draft.scopes.map(({ name, paths }) => ({ name, paths })),
      rules: draft.rules.map((rule) => ({ ...rule, key: 0 })),
    });
  return raw(left) === raw(right);
}

function SectionNote(props: { children: string; id?: string }) {
  return (
    <div id={props.id} style={{ fontSize: 12, color: SOFT_INK }}>
      {props.children}
    </div>
  );
}

/** A single-line or multiline text field with its label and optional hint. */
function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  suggestions?: string[];
  focus?: string;
  multiline?: boolean;
}) {
  const { label, value, onChange, hint, suggestions, focus, multiline } = props;
  const base = useId();
  const hintId = `${base}-hint`;
  const listId = `${base}-list`;
  const common = {
    id: `${base}-input`,
    "data-focus": focus,
    value,
    "aria-describedby": hint === undefined ? undefined : hintId,
  };
  return (
    <div>
      <label htmlFor={common.id}>{label}</label>
      {multiline === true ? (
        <textarea {...common} rows={4} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input
          {...common}
          type="text"
          list={suggestions === undefined ? undefined : listId}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint === undefined ? null : <SectionNote id={hintId}>{hint}</SectionNote>}
      {suggestions === undefined ? null : (
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
    </div>
  );
}

/** A list of strings: an input plus Add, and one removable tag per entry. Leaving the input also adds it. */
function TagList(props: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  hint?: string;
  suggestions?: string[];
}) {
  const { label, values, onChange, hint, suggestions } = props;
  const base = useId();
  const hintId = `${base}-hint`;
  const listId = `${base}-list`;
  const [pending, setPending] = useState("");
  const add = () => {
    const value = pending.trim();
    if (value === "") return;
    onChange([...values, value]);
    setPending("");
  };
  return (
    <div data-tag-list="">
      <label htmlFor={`${base}-input`}>{label}</label>
      {values.length === 0 ? null : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 4 }}>
          {values.map((value, index) => (
            <li key={index} style={{ border: RULE, borderRadius: 6, padding: "0 4px" }}>
              <span>{value}</span>{" "}
              <button
                type="button"
                aria-label={`Remove ${value}`}
                onClick={() => onChange(values.filter((_, at) => at !== index))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          id={`${base}-input`}
          type="text"
          value={pending}
          list={suggestions === undefined ? undefined : listId}
          aria-describedby={hint === undefined ? undefined : hintId}
          onChange={(event) => setPending(event.target.value)}
          onBlur={add}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <button type="button" onClick={add}>
          Add
        </button>
      </div>
      {hint === undefined ? null : <SectionNote id={hintId}>{hint}</SectionNote>}
      {suggestions === undefined ? null : (
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
    </div>
  );
}

/** Checkboxes for the known names, and a tag list for every other entry (globs, or names not known now). */
function PickList(props: {
  legend: string;
  known: Array<{ name: string; description?: string }>;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const { legend, known, values, onChange } = props;
  const base = useId();
  const names = known.map((entry) => entry.name);
  return (
    <fieldset style={{ margin: 0, padding: 8, border: RULE, borderRadius: 6 }}>
      <legend>{legend}</legend>
      {known.map((entry, index) => {
        const id = `${base}-pick-${index}`;
        return (
          <div key={entry.name}>
            <input
              id={id}
              type="checkbox"
              checked={values.includes(entry.name)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...values, entry.name]
                    : values.filter((value) => value !== entry.name),
                )
              }
            />
            <label htmlFor={id}>
              <span>{entry.name}</span>
              {entry.description === undefined ? null : (
                <>
                  {" "}
                  <span style={{ fontSize: 12, color: SOFT_INK }}>{entry.description}</span>
                </>
              )}
            </label>
          </div>
        );
      })}
      <TagList
        label="Other patterns"
        values={values.filter((value) => !names.includes(value))}
        onChange={(others) => onChange([...values.filter((value) => names.includes(value)), ...others])}
      />
    </fieldset>
  );
}

function SharedTexts(props: {
  rows: VarRow[];
  duplicates: Set<number>;
  onChange: (key: number, patch: Partial<VarRow>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  return (
    <section aria-labelledby="mi-shared-heading">
      <h4 id="mi-shared-heading" style={{ margin: "0 0 4px" }}>
        Shared texts
      </h4>
      <SectionNote>{"Use a shared text as {{name}} in a rule's instructions."}</SectionNote>
      <ul style={{ listStyle: "none", margin: "8px 0", padding: 0 }}>
        {props.rows.map((row, index) => (
          <li key={row.key} style={{ padding: "8px 0", borderTop: RULE }}>
            <TextField
              label="Name"
              value={row.name}
              focus={`var:${row.key}`}
              hint={props.duplicates.has(row.key) ? DUPLICATE_NOTE : undefined}
              onChange={(name) => props.onChange(row.key, { name })}
            />
            <TextField
              label="Text"
              value={row.text}
              multiline
              onChange={(text) => props.onChange(row.key, { text })}
            />
            <button
              type="button"
              aria-label={`Remove shared text ${row.name.trim() === "" ? index + 1 : row.name.trim()}`}
              onClick={() => props.onRemove(index)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <button type="button" data-focus="add-var" onClick={props.onAdd}>
        Add shared text
      </button>
    </section>
  );
}

function ScopeCard(props: {
  row: ScopeRow;
  position: number;
  ignored: boolean;
  onChange: (patch: Partial<ScopeRow>) => void;
  onRemove: () => void;
  onAddPath: () => void;
  onRemovePath: (index: number) => void;
}) {
  const { row, position, ignored, onChange, onRemove, onAddPath, onRemovePath } = props;
  const base = useId();
  const name = row.name.trim();
  const title = name === "" ? `Directory scope ${position}` : name;
  const noteId = `${base}-note`;
  const hintId = `${base}-hint`;
  return (
    <li style={{ padding: "8px 0", borderTop: RULE }}>
      <fieldset style={{ margin: 0, padding: 0, border: "none" }}>
        <legend style={{ color: "var(--ink)", fontWeight: 500 }}>{title}</legend>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <label htmlFor={`${base}-name`}>Name</label>
            <input
              id={`${base}-name`}
              data-focus={`scope:${row.key}`}
              type="text"
              value={row.name}
              aria-describedby={ignored ? noteId : undefined}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </div>
          {ignored ? <SectionNote id={noteId}>{IGNORED_NOTE}</SectionNote> : null}
          <fieldset style={{ margin: 0, padding: 8, border: RULE, borderRadius: 6 }}>
            <legend id={`${base}-legend`}>Directories</legend>
            {row.paths.map((value, index) => (
              <div key={index} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  data-focus={`path:${row.key}:${index}`}
                  type="text"
                  value={value}
                  aria-labelledby={`${base}-legend`}
                  aria-describedby={hintId}
                  onChange={(event) =>
                    onChange({
                      paths: row.paths.map((path, at) => (at === index ? event.target.value : path)),
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={
                    value.trim() === "" ? "Remove empty directory row" : `Remove directory ${value.trim()}`
                  }
                  onClick={() => onRemovePath(index)}
                >
                  Remove
                </button>
              </div>
            ))}
            <SectionNote id={hintId}>Absolute or ~/…</SectionNote>
            <button type="button" data-focus={`add-path:${row.key}`} onClick={onAddPath}>
              Add directory
            </button>
          </fieldset>
          <div>
            <button
              type="button"
              aria-label={name === "" ? `Remove ${title}` : `Remove directory scope ${name}`}
              onClick={onRemove}
            >
              Remove
            </button>
          </div>
        </div>
      </fieldset>
    </li>
  );
}

function Directories(props: {
  rows: ScopeRow[];
  profileScopes: ConfigState["profileScopes"];
  ignored: string[];
  onChange: (key: number, patch: Partial<ScopeRow>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onAddPath: (row: ScopeRow) => void;
  onRemovePath: (row: ScopeRow, index: number) => void;
}) {
  const profileNames = props.profileScopes.map((scope) => scope.name);
  return (
    <section aria-labelledby="mi-directories-heading">
      <h4 id="mi-directories-heading" style={{ margin: "0 0 4px" }}>
        Directories
      </h4>
      <SectionNote>
        A rule limited to a directory applies when the thread's workspace or its project's checkout is inside it.
      </SectionNote>
      <ul style={{ listStyle: "none", margin: "8px 0", padding: 0 }}>
        {props.rows.map((row, index) => {
          const name = row.name.trim();
          return (
            <ScopeCard
              key={row.key}
              row={row}
              position={index + 1}
              ignored={profileNames.includes(name) || props.ignored.includes(name)}
              onChange={(patch) => props.onChange(row.key, patch)}
              onRemove={() => props.onRemove(index)}
              onAddPath={() => props.onAddPath(row)}
              onRemovePath={(at) => props.onRemovePath(row, at)}
            />
          );
        })}
      </ul>
      <button type="button" data-focus="add-scope" onClick={props.onAdd}>
        Add directory scope
      </button>
      {props.profileScopes.length === 0 ? null : (
        <div style={{ marginTop: 8 }}>
          <h5 style={{ margin: 0 }}>From profiles.json</h5>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {props.profileScopes.map((scope) => (
              <li key={scope.name} style={{ padding: "8px 0", borderTop: RULE }}>
                <strong style={{ color: "var(--ink)" }}>{scope.name}</strong>{" "}
                <span>{scope.paths.join(", ")}</span>
                <SectionNote>{PROFILE_NOTE}</SectionNote>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const THREAD_OPTIONS: Array<{ value: Threads; label: string }> = [
  { value: "any", label: "Any" },
  { value: "top-level", label: "Top-level" },
  { value: "child", label: "Child" },
];

function RuleCard(props: {
  row: RuleRow;
  position: number;
  count: number;
  state: ConfigState;
  scopeNames: string[];
  vars: Record<string, string>;
  onChange: (patch: Partial<RuleRow>) => void;
  onMove: (offset: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { row, position, count, state, scopeNames, vars, onChange } = props;
  const base = useId();
  const title = row.name.trim() === "" ? `Rule ${position}` : row.name.trim();
  const countId = `${base}-count`;
  const { length, unknown } = previewLength(row.instructions, vars);
  const over = length > LIMIT;
  const models = state.providers.some((provider) => provider.id === row.provider.trim())
    ? state.providers.filter((provider) => provider.id === row.provider.trim()).flatMap((provider) => provider.models)
    : [...new Set(state.providers.flatMap((provider) => provider.models))];
  const projectNames = state.projects.map((project) => project.name);
  return (
    <fieldset style={{ margin: "0 0 12px", padding: 12, border: RULE, borderRadius: 8 }}>
      <legend style={{ color: "var(--ink)", fontWeight: 500 }}>{title}</legend>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <TextField
          label="Name (optional)"
          value={row.name}
          focus={`rule:${row.key}`}
          onChange={(name) => onChange({ name })}
        />
        <fieldset style={{ margin: 0, padding: 8, border: RULE, borderRadius: 6 }}>
          <legend>Applies to</legend>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <TextField
              label="Provider"
              value={row.provider}
              hint="Empty for any. * matches any characters."
              suggestions={state.providers.map((provider) => provider.id)}
              onChange={(provider) => onChange({ provider })}
            />
            <TextField
              label="Model"
              value={row.model}
              hint="Empty for any. * matches any characters."
              suggestions={models}
              onChange={(model) => onChange({ model })}
            />
            <div>
              <label htmlFor={`${base}-threads`}>Thread</label>
              <select
                id={`${base}-threads`}
                value={row.threads}
                onChange={(event) => onChange({ threads: event.target.value as Threads })}
              >
                {THREAD_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <TagList
              label="Projects"
              values={row.project}
              hint="Project names; * matches any characters."
              suggestions={projectNames}
              onChange={(project) => onChange({ project })}
            />
            <TagList
              label="Skip projects"
              values={row.skipProjects}
              hint="Project names; * matches any characters."
              suggestions={projectNames}
              onChange={(skipProjects) => onChange({ skipProjects })}
            />
            <TagList
              label="Skip titles"
              values={row.skipTitles}
              hint="Thread titles; * matches any characters."
              onChange={(skipTitles) => onChange({ skipTitles })}
            />
            <PickList
              legend="Directories"
              known={scopeNames.map((name) => ({ name }))}
              values={row.scope}
              onChange={(scope) => onChange({ scope })}
            />
          </div>
        </fieldset>
        <PickList
          legend="Skills"
          known={state.skills}
          values={row.skills}
          onChange={(skills) => onChange({ skills })}
        />
        <div>
          <TextField
            label="Instructions"
            value={row.instructions}
            multiline
            onChange={(instructions) => onChange({ instructions })}
          />
          <div id={countId} style={{ fontSize: 12, color: over ? DESTRUCTIVE : SOFT_INK }}>
            {over ? `${length} / ${LIMIT} characters — over the limit` : `${length} / ${LIMIT} characters`}
          </div>
          {unknown.map((name) => (
            <div key={name} style={{ fontSize: 12, color: DESTRUCTIVE }}>
              {`Unknown shared text {{${name}}}`}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            data-focus={`up:${row.key}`}
            disabled={position === 1}
            onClick={() => props.onMove(-1)}
          >
            Move up
          </button>
          <button
            type="button"
            data-focus={`down:${row.key}`}
            disabled={position === count}
            onClick={() => props.onMove(1)}
          >
            Move down
          </button>
          <button type="button" onClick={props.onDuplicate}>
            Duplicate
          </button>
          <button type="button" aria-label={`Delete ${title}`} onClick={props.onDelete}>
            Delete
          </button>
        </div>
      </div>
    </fieldset>
  );
}

function LoadFailure(props: { error: string; onRetry: () => void }) {
  return (
    <div role="alert" style={{ color: DESTRUCTIVE }}>
      <p>Could not load the configuration: {props.error}</p>
      <button type="button" onClick={props.onRetry}>
        Retry
      </button>
    </div>
  );
}

function LegacyBanner(props: { error: NonNullable<ConfigState["loadError"]>; onDismiss: () => void }) {
  return (
    <section aria-labelledby="mi-legacy-heading" style={{ border: RULE, borderRadius: 8, padding: 12 }}>
      <h4 id="mi-legacy-heading" style={{ margin: "0 0 4px", color: DESTRUCTIVE }}>
        The old rules setting could not be imported
      </h4>
      <p style={{ margin: "0 0 8px" }}>{props.error.message}</p>
      <pre
        style={{
          margin: "0 0 8px",
          padding: 8,
          border: RULE,
          borderRadius: 6,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          fontFamily: "ui-monospace, monospace",
        }}
      >
        {props.error.legacyText}
      </pre>
      <button type="button" onClick={props.onDismiss}>
        Dismiss old text
      </button>
      <SectionNote>{LEGACY_FIX}</SectionNote>
    </section>
  );
}

function newRule(key: number): RuleRow {
  return {
    key,
    name: "",
    provider: "",
    model: "",
    threads: "any",
    project: [],
    skipProjects: [],
    skipTitles: [],
    scope: [],
    skills: [],
    instructions: "",
  };
}

const EMPTY_DRAFT: Draft = { vars: [], scopes: [], rules: [] };

function Instructions() {
  const rpc = useRpc<ModelInstructionsRpcContract>();
  const [state, setState] = useState<ConfigState | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loaded, setLoaded] = useState<Draft>(EMPTY_DRAFT);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const revisionRef = useRef(0);
  const nextKeyRef = useRef(0);
  const focusRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dirty = !sameDrafts(draft, loaded);
  // Any edit, even an empty row: this gates reloads, so Add directory is not undone by a window focus.
  const edited = !sameRawDrafts(draft, loaded);
  const editedRef = useRef(edited);
  const draftRef = useRef(draft);

  // Layout effects, not passive ones: a passive effect can still be pending when the next click or load
  // response arrives, so the refs would be stale and the focus target would be looked up in the old DOM.
  useLayoutEffect(() => {
    editedRef.current = edited;
    draftRef.current = draft;
  }, [edited, draft]);

  useLayoutEffect(() => {
    const target = focusRef.current;
    if (target === null) return;
    focusRef.current = null;
    rootRef.current!.querySelector<HTMLElement>(`[data-focus="${target}"]`)!.focus();
  });

  const apply = useCallback((result: ConfigState) => {
    const next = fromConfig(result.config, draftRef.current, () => nextKeyRef.current++);
    setState(result);
    setDraft(next);
    setLoaded(next);
  }, []);

  const load = useCallback(async () => {
    const revision = ++revisionRef.current;
    try {
      const result = await rpc.call("getState", null);
      // A newer load or a save supersedes this one; unsaved edits are never replaced.
      if (revision !== revisionRef.current || editedRef.current) return;
      apply(result);
      setLoadFailure(null);
    } catch (error) {
      if (revision !== revisionRef.current) return;
      setLoadFailure(describeError(error));
    }
  }, [rpc, apply]);

  useEffect(() => {
    void load();
    const onFocus = () => {
      if (!editedRef.current) void load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const save = async () => {
    revisionRef.current++;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const result = await rpc.call("saveConfig", { config: toPayload(draft) });
      // The save supersedes a load that started while it ran.
      revisionRef.current++;
      focusRef.current = "add-rule";
      apply(result);
      setSaved(true);
    } catch (error) {
      setSaveError(describeError(error));
    } finally {
      setSaving(false);
    }
  };

  const dismissLegacy = async () => {
    try {
      // Only the state changes: unsaved edits in the form are not replaced.
      setState(await rpc.call("dismissLegacy", null));
    } catch (error) {
      setSaveError(describeError(error));
    }
  };

  const edit = (change: (current: Draft) => Draft) => {
    setSaved(false);
    setDraft(change);
  };

  const updateVar = (key: number, patch: Partial<VarRow>) =>
    edit((current) => ({
      ...current,
      vars: current.vars.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    }));
  const updateScope = (key: number, patch: Partial<ScopeRow>) =>
    edit((current) => ({
      ...current,
      scopes: current.scopes.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    }));
  const updateRule = (key: number, patch: Partial<RuleRow>) =>
    edit((current) => ({
      ...current,
      rules: current.rules.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    }));

  const addVar = () => {
    const key = nextKeyRef.current++;
    focusRef.current = `var:${key}`;
    edit((current) => ({ ...current, vars: [...current.vars, { key, name: "", text: "" }] }));
  };

  const removeVar = (index: number) => {
    const next = draft.vars[index + 1];
    focusRef.current = next === undefined ? "add-var" : `var:${next.key}`;
    edit((current) => ({ ...current, vars: current.vars.filter((_, at) => at !== index) }));
  };

  const addScope = () => {
    const key = nextKeyRef.current++;
    focusRef.current = `scope:${key}`;
    edit((current) => ({ ...current, scopes: [...current.scopes, { key, name: "", paths: [""] }] }));
  };

  const removeScope = (index: number) => {
    const next = draft.scopes[index + 1];
    focusRef.current = next === undefined ? "add-scope" : `scope:${next.key}`;
    edit((current) => ({ ...current, scopes: current.scopes.filter((_, at) => at !== index) }));
  };

  const addPath = (row: ScopeRow) => {
    focusRef.current = `path:${row.key}:${row.paths.length}`;
    updateScope(row.key, { paths: [...row.paths, ""] });
  };

  const removePath = (row: ScopeRow, index: number) => {
    focusRef.current =
      index < row.paths.length - 1 ? `path:${row.key}:${index}` : `add-path:${row.key}`;
    updateScope(row.key, { paths: row.paths.filter((_, at) => at !== index) });
  };

  const addRule = () => {
    const key = nextKeyRef.current++;
    focusRef.current = `rule:${key}`;
    edit((current) => ({ ...current, rules: [...current.rules, newRule(key)] }));
  };

  const deleteRule = (index: number) => {
    const next = draft.rules[index + 1];
    focusRef.current = next === undefined ? "add-rule" : `rule:${next.key}`;
    edit((current) => ({ ...current, rules: current.rules.filter((_, at) => at !== index) }));
  };

  const duplicateRule = (index: number) => {
    const key = nextKeyRef.current++;
    focusRef.current = `rule:${key}`;
    edit((current) => {
      const copy = { ...current.rules[index]!, key };
      return { ...current, rules: [...current.rules.slice(0, index + 1), copy, ...current.rules.slice(index + 1)] };
    });
  };

  const moveRule = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    const row = draft.rules[index]!;
    // The moved card keeps the focus on the button that was used, unless it is now at that end.
    focusRef.current =
      offset === -1
        ? `${target === 0 ? "down" : "up"}:${row.key}`
        : `${target === draft.rules.length - 1 ? "up" : "down"}:${row.key}`;
    edit((current) => {
      const rules = [...current.rules];
      rules[index] = rules[target]!;
      rules[target] = row;
      return { ...current, rules };
    });
  };

  if (state === null) {
    if (loadFailure === null) return <p style={{ color: SOFT_INK }}>Loading…</p>;
    return <LoadFailure error={loadFailure} onRetry={() => void load()} />;
  }

  const varsMap = toPayload(draft).vars;
  const duplicates = duplicateVarKeys(draft.vars);
  const scopeNames = [
    ...new Set([
      ...draft.scopes.map((scope) => scope.name.trim()).filter((name) => name !== ""),
      ...state.profileScopes.map((scope) => scope.name),
    ]),
  ];
  return (
    <div ref={rootRef} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {loadFailure === null ? null : <LoadFailure error={loadFailure} onRetry={() => void load()} />}
      {state.loadError === null ? null : (
        <LegacyBanner error={state.loadError} onDismiss={() => void dismissLegacy()} />
      )}
      <fieldset disabled={saving} style={{ margin: 0, padding: 0, border: "none" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <SharedTexts rows={draft.vars} duplicates={duplicates} onChange={updateVar} onAdd={addVar} onRemove={removeVar} />
          <Directories
            rows={draft.scopes}
            profileScopes={state.profileScopes}
            ignored={state.ignoredScopes}
            onChange={updateScope}
            onAdd={addScope}
            onRemove={removeScope}
            onAddPath={addPath}
            onRemovePath={removePath}
          />
          <section aria-labelledby="mi-rules-heading">
            <h4 id="mi-rules-heading" style={{ margin: "0 0 4px" }}>
              Rules
            </h4>
            <SectionNote>
              Every matching rule applies, top first. When the text is over the limit, earlier rules are kept first.
            </SectionNote>
            <div style={{ margin: "8px 0" }}>
              {draft.rules.map((row, index) => (
                <RuleCard
                  key={row.key}
                  row={row}
                  position={index + 1}
                  count={draft.rules.length}
                  state={state}
                  scopeNames={scopeNames}
                  vars={varsMap}
                  onChange={(patch) => updateRule(row.key, patch)}
                  onMove={(offset) => moveRule(index, offset)}
                  onDuplicate={() => duplicateRule(index)}
                  onDelete={() => deleteRule(index)}
                />
              ))}
            </div>
            <button type="button" data-focus="add-rule" onClick={addRule}>
              Add rule
            </button>
          </section>
          {saveError === null ? null : (
            <div role="alert" style={{ color: DESTRUCTIVE }}>
              <div>{saveError}</div>
              {saveError.startsWith(NOT_CHECKABLE_PREFIX) ? <div>{NOT_CHECKABLE_HINT}</div> : null}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" disabled={!dirty || saving || duplicates.size > 0} onClick={() => void save()}>
              Save
            </button>
            <button
              type="button"
              disabled={!edited || saving}
              onClick={() => {
                focusRef.current = "add-rule";
                setDraft(loaded);
                setSaveError(null);
              }}
            >
              Discard changes
            </button>
          </div>
        </div>
      </fieldset>
      <output style={{ display: "block", margin: 0, fontSize: 12, color: SOFT_INK }}>
        {saved ? "Saved" : ""}
      </output>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "instructions",
    title: "Instructions",
    description:
      "Instructions and skills that bb adds to agent threads, by directory, project, provider, model and thread type. Checked when you save: a rule set that would push a known thread past bb's 4096-character limit is rejected.",
    component: Instructions,
  });
});
