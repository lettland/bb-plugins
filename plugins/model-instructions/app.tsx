import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { ConfigState, ModelInstructionsRpcContract, RawConfig } from "./rpc-contract";
import { globToRegExp } from "./src/glob";
import * as ui from "./src/ui";
import { previewLength } from "./src/vars";

// bb's limit for one thread's instructions; the server checks the same number.
const LIMIT = 4096;
const IGNORED_NOTE = "Ignored: a profile scope with this name comes from profiles.json";
const PROFILE_NOTE = "Claude profile — edit ~/.bb/model-instructions/profiles.json";
const NOT_CHECKABLE_PREFIX = "budget not checkable yet";
const NOT_CHECKABLE_HINT = "bb is still loading the provider and project lists; try again in a moment.";
const DUPLICATE_NOTE = "This name is already used above; rename one of them.";
const NO_SCOPE_NOTE = "Matches no directory scope";
const STORED_FIX =
  "Saving here replaces it. To keep it, run bb model-instructions export, fix the file, and import it.";

type RawRule = RawConfig["rules"][number];
type Threads = RawRule["threads"];
/** The rule fields that are lists with a typing box, and so can hold text that was typed but not added. */
type ListField = "project" | "skipProjects" | "skipTitles" | "scope" | "skills";
type Pending = Record<ListField, string>;

const noPending = (): Pending => ({ project: "", skipProjects: "", skipTitles: "", scope: "", skills: "" });

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Server messages count from 0 and say rules[n] or scopes[n]; the cards say Rule n+1 and Directory scope n+1,
 * followed by the card's name in brackets when it has one.
 */
function cardNames(message: string, draft: Draft): string {
  const titled = (label: string, index: number, name: string | undefined) => {
    const trimmed = name?.trim() ?? "";
    return trimmed === "" ? `${label} ${index + 1}` : `${label} ${index + 1} (${trimmed})`;
  };
  return message
    .replace(/\brules\[(\d+)\]/g, (_, index: string) =>
      titled("Rule", Number(index), draft.rules[Number(index)]?.name),
    )
    .replace(/\bscopes\[(\d+)\]/g, (_, index: string) =>
      titled("Directory scope", Number(index), draft.scopes[Number(index)]?.name),
    );
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
  /** Text typed in a list's box and not added yet. */
  pending: Pending;
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
      pending: noPending(),
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
    // Text typed in a box and not added yet is sent as if it was added.
    project: listOrUndefined([...rule.project, rule.pending.project]),
    skipProjects: listOrUndefined([...rule.skipProjects, rule.pending.skipProjects]),
    skipTitles: listOrUndefined([...rule.skipTitles, rule.pending.skipTitles]),
    scope: listOrUndefined([...rule.scope, rule.pending.scope]),
    skills: listOrUndefined([...rule.skills, rule.pending.skills]),
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
    <div id={props.id} className={ui.hint}>
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
    <div className={ui.field}>
      <label htmlFor={common.id} className={ui.label}>
        {label}
      </label>
      {multiline === true ? (
        <textarea {...common} rows={4} className={ui.textarea} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input
          {...common}
          className={ui.input}
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

/**
 * A list of strings: an input plus Add, and one removable tag per entry. Leaving the input also adds it.
 * The typed text lives in the form's draft, so it counts as a change until it is added or discarded.
 */
function TagList(props: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  pending: string;
  onPending: (text: string) => void;
  hint?: string;
  suggestions?: string[];
  /** A short note shown next to an entry, or undefined for none. */
  noteFor?: (value: string) => string | undefined;
}) {
  const { label, values, onChange, pending, onPending, hint, suggestions, noteFor } = props;
  const base = useId();
  const hintId = `${base}-hint`;
  const listId = `${base}-list`;
  const add = () => {
    const value = pending.trim();
    if (value === "") return;
    onChange([...values, value]);
    onPending("");
  };
  return (
    <div data-tag-list="" className={ui.field}>
      <label htmlFor={`${base}-input`} className={ui.label}>
        {label}
      </label>
      {values.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {values.map((value, index) => {
            const note = noteFor?.(value);
            return (
              <li key={index} className={ui.badge}>
                <span>{value}</span>{" "}
                {note === undefined ? null : (
                  <>
                    <span className="text-muted-foreground">{note}</span>{" "}
                  </>
                )}
                <button
                  type="button"
                  className={ui.chipButton}
                  aria-label={`Remove ${value}`}
                  onClick={() => onChange(values.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          id={`${base}-input`}
          className={ui.input}
          type="text"
          value={pending}
          list={suggestions === undefined ? undefined : listId}
          aria-describedby={hint === undefined ? undefined : hintId}
          onChange={(event) => onPending(event.target.value)}
          onBlur={add}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <button type="button" className={ui.button.outline} onClick={add}>
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
  pending: string;
  onPending: (text: string) => void;
  noteFor?: (value: string) => string | undefined;
}) {
  const { legend, known, values, onChange, pending, onPending, noteFor } = props;
  const base = useId();
  const names = known.map((entry) => entry.name);
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className={ui.cx(ui.label, "mb-2 p-0")}>{legend}</legend>
      {known.map((entry, index) => {
        const id = `${base}-pick-${index}`;
        return (
          <div key={entry.name} className="flex items-center gap-2 text-sm">
            <input
              id={id}
              className="accent-foreground"
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
                  <span className={ui.hint}>{entry.description}</span>
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
        pending={pending}
        onPending={onPending}
        noteFor={noteFor}
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
    <section aria-labelledby="mi-shared-heading" className={ui.card}>
      <h4 id="mi-shared-heading" className={ui.cx(ui.cardTitle, "m-0")}>
        Shared texts
      </h4>
      <div className={ui.cardNote}>{"Use a shared text as {{name}} in a rule's instructions."}</div>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {props.rows.map((row, index) => (
          <li key={row.key} className="flex flex-col gap-3 border-t border-border pt-3">
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
              className={ui.cx(ui.buttonSm.ghost, "self-start")}
              aria-label={`Remove shared text ${row.name.trim() === "" ? index + 1 : row.name.trim()}`}
              onClick={() => props.onRemove(index)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className={ui.cx(ui.button.outline, "self-start")} data-focus="add-var" onClick={props.onAdd}>
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
    <li>
      <fieldset className={ui.cx(ui.card, "m-0 min-w-0")}>
        <legend className={ui.cx(ui.cardTitle, "px-1")}>{title}</legend>
        <div className="flex flex-col gap-3">
          <div className={ui.field}>
            <label htmlFor={`${base}-name`} className={ui.label}>
              Name
            </label>
            <input
              id={`${base}-name`}
              className={ui.input}
              data-focus={`scope:${row.key}`}
              type="text"
              value={row.name}
              aria-describedby={ignored ? noteId : undefined}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </div>
          {ignored ? <SectionNote id={noteId}>{IGNORED_NOTE}</SectionNote> : null}
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend id={`${base}-legend`} className={ui.cx(ui.label, "mb-2 p-0")}>
              Directories
            </legend>
            {row.paths.map((value, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  className={ui.input}
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
                  className={ui.buttonSm.ghost}
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
            <button
              type="button"
              className={ui.cx(ui.button.outline, "self-start")}
              data-focus={`add-path:${row.key}`}
              onClick={onAddPath}
            >
              Add directory
            </button>
          </fieldset>
          <div>
            <button
              type="button"
              className={ui.buttonSm.ghost}
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
    <section aria-labelledby="mi-directories-heading" className={ui.card}>
      <h4 id="mi-directories-heading" className={ui.cx(ui.cardTitle, "m-0")}>
        Directories
      </h4>
      <div className={ui.cardNote}>
        A rule limited to a directory applies when the thread's workspace or its project's checkout is inside it.
      </div>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
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
      <button type="button" className={ui.cx(ui.button.outline, "self-start")} data-focus="add-scope" onClick={props.onAdd}>
        Add directory scope
      </button>
      {props.profileScopes.length === 0 ? null : (
        <div className="flex flex-col gap-3">
          <h5 className={ui.cx(ui.label, "m-0")}>From profiles.json</h5>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {props.profileScopes.map((scope) => (
              <li key={scope.name} className={ui.cardMuted}>
                <strong className={ui.label}>{scope.name}</strong>{" "}
                <span className="text-sm">{scope.paths.join(", ")}</span>
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
  const pendingOf = (field: ListField) => ({
    pending: row.pending[field],
    onPending: (text: string) => onChange({ pending: { ...row.pending, [field]: text } }),
  });
  const matchesNoScope = (value: string) =>
    scopeNames.some((name) => globToRegExp(value).test(name)) ? undefined : NO_SCOPE_NOTE;
  return (
    <fieldset className={ui.cx(ui.card, "@container m-0 min-w-0")}>
      <legend className={ui.cx(ui.cardTitle, "px-1")}>{title}</legend>
      <div className="flex flex-col gap-4">
        <TextField
          label="Name (optional)"
          value={row.name}
          focus={`rule:${row.key}`}
          onChange={(name) => onChange({ name })}
        />
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className={ui.cx(ui.label, "mb-2 p-0")}>Applies to</legend>
          <div className="grid gap-3 @sm:grid-cols-2">
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
            <div className={ui.field}>
              <label htmlFor={`${base}-threads`} className={ui.label}>
                Thread
              </label>
              <select
                id={`${base}-threads`}
                className={ui.input}
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
              {...pendingOf("project")}
            />
            <TagList
              label="Skip projects"
              values={row.skipProjects}
              hint="Project names; * matches any characters."
              suggestions={projectNames}
              onChange={(skipProjects) => onChange({ skipProjects })}
              {...pendingOf("skipProjects")}
            />
            <TagList
              label="Skip titles"
              values={row.skipTitles}
              hint="Thread titles; * matches any characters."
              onChange={(skipTitles) => onChange({ skipTitles })}
              {...pendingOf("skipTitles")}
            />
            <PickList
              legend="Directories"
              known={scopeNames.map((name) => ({ name }))}
              values={row.scope}
              onChange={(scope) => onChange({ scope })}
              {...pendingOf("scope")}
              noteFor={matchesNoScope}
            />
          </div>
        </fieldset>
        <PickList
          legend="Skills"
          known={state.skills}
          values={row.skills}
          onChange={(skills) => onChange({ skills })}
          {...pendingOf("skills")}
        />
        <div className={ui.field}>
          <TextField
            label="Instructions"
            value={row.instructions}
            multiline
            onChange={(instructions) => onChange({ instructions })}
          />
          <div id={countId} className={over ? ui.errorHint : ui.hint}>
            {over ? `${length} / ${LIMIT} characters — over the limit` : `${length} / ${LIMIT} characters`}
          </div>
          {unknown.map((name) => (
            <div key={name} className={ui.errorHint}>
              {`Unknown shared text {{${name}}}`}
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={ui.buttonSm.ghost}
            data-focus={`up:${row.key}`}
            disabled={position === 1}
            onClick={() => props.onMove(-1)}
          >
            Move up
          </button>
          <button
            type="button"
            className={ui.buttonSm.ghost}
            data-focus={`down:${row.key}`}
            disabled={position === count}
            onClick={() => props.onMove(1)}
          >
            Move down
          </button>
          <button type="button" className={ui.buttonSm.ghost} onClick={props.onDuplicate}>
            Duplicate
          </button>
          <button type="button" className={ui.buttonSm.destructive} aria-label={`Delete ${title}`} onClick={props.onDelete}>
            Delete
          </button>
        </div>
      </div>
    </fieldset>
  );
}

function LoadFailure(props: { error: string; onRetry: () => void }) {
  return (
    <div role="alert" className={ui.cx(ui.banner, "flex flex-col gap-2")}>
      <p className={ui.cx(ui.bannerTitle, "m-0")}>Could not load the configuration: {props.error}</p>
      <button type="button" className={ui.cx(ui.button.outline, "self-start")} onClick={props.onRetry}>
        Retry
      </button>
    </div>
  );
}

function assertNever(value: never): never {
  throw new Error(`unexpected load error ${JSON.stringify(value)}`);
}

function BannerBox(props: { heading: string; children: ReactNode }) {
  return (
    <section aria-labelledby="mi-banner-heading" className={ui.cx(ui.banner, "flex flex-col gap-2")}>
      <h4 id="mi-banner-heading" className={ui.cx(ui.bannerTitle, "m-0")}>
        {props.heading}
      </h4>
      {props.children}
    </section>
  );
}

function Banner(props: { error: NonNullable<ConfigState["loadError"]>; onKeep: () => void }) {
  const { error } = props;
  switch (error.kind) {
    case "storage":
      return (
        <BannerBox heading="The plugin's storage could not be read">
          <p className="m-0">{error.message}</p>
        </BannerBox>
      );
    case "stored":
      return (
        <BannerBox heading="The saved configuration could not be loaded">
          <p className="m-0">{error.message}</p>
          {error.text === "" ? null : (
            <pre className={ui.cx(ui.pre, "m-0")}>{error.text}</pre>
          )}
          <SectionNote>{STORED_FIX}</SectionNote>
        </BannerBox>
      );
    case "migration":
      return (
        <BannerBox heading="Your rules from the previous version were not moved">
          <p className="m-0">{error.message}</p>
        </BannerBox>
      );
    case "conflict":
      return (
        <BannerBox heading="Your rules from the previous version differ from the rules saved here">
          <p className="m-0">{error.message}</p>
          <button type="button" className={ui.cx(ui.button.outline, "self-start")} onClick={props.onKeep}>
            Keep the rules saved here
          </button>
        </BannerBox>
      );
    default:
      return assertNever(error);
  }
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
    pending: noPending(),
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
      setSaveError(cardNames(describeError(error), draft));
    } finally {
      setSaving(false);
    }
  };

  const keepSavedRules = async () => {
    try {
      // Only the state changes: unsaved edits in the form are not replaced.
      setState(await rpc.call("keepSavedRules", null));
    } catch (error) {
      setSaveError(cardNames(describeError(error), draft));
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
    if (loadFailure === null) return <p className={ui.cx(ui.cardNote, "m-0")}>Loading…</p>;
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
    <div ref={rootRef} className="flex flex-col gap-4">
      {loadFailure === null ? null : <LoadFailure error={loadFailure} onRetry={() => void load()} />}
      {state.loadError === null ? null : (
        <Banner error={state.loadError} onKeep={() => void keepSavedRules()} />
      )}
      <fieldset disabled={saving} className="m-0 min-w-0 border-0 p-0">
        <div className="flex flex-col gap-4">
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
          <section aria-labelledby="mi-rules-heading" className={ui.card}>
            <h4 id="mi-rules-heading" className={ui.cx(ui.cardTitle, "m-0")}>
              Rules
            </h4>
            <div className={ui.cardNote}>
              Every matching rule applies, top first. When the text is over the limit, earlier rules are kept first.
            </div>
            <div className="flex flex-col gap-3">
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
            <button type="button" className={ui.cx(ui.button.outline, "self-start")} data-focus="add-rule" onClick={addRule}>
              Add rule
            </button>
          </section>
          {saveError === null ? null : (
            <div role="alert" className={ui.cx(ui.banner, "text-destructive")}>
              <div className="whitespace-pre-wrap">{saveError}</div>
              {saveError.startsWith(NOT_CHECKABLE_PREFIX) ? <div>{NOT_CHECKABLE_HINT}</div> : null}
            </div>
          )}
          <div className="flex gap-2">
            <button type="button" className={ui.button.primary} disabled={!dirty || saving || duplicates.size > 0} onClick={() => void save()}>
              Save
            </button>
            <button
              type="button"
              className={ui.button.outline}
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
      <output className={ui.cx(ui.hint, "m-0 block")}>
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
