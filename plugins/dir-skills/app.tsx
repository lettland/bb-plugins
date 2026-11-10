import { useCallback, useEffect, useId, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { DirSkillsRpcContract, FileScope, ScopesSnapshot, UiScope } from "./rpc-contract";

const SOFT_INK = "color-mix(in oklch, var(--ink) 68%, var(--canvas))";
const RULE = "1px solid color-mix(in oklch, var(--ink) 11%, var(--canvas))";
const PROFILE_NOTE = "Claude profile — edit in ~/.bb/dir-skills/scopes.json";
const IGNORED_NOTE =
  "will be ignored: a scope with a Claude profile can only be changed in ~/.bb/dir-skills/scopes.json";
// Limits of the RPC contract (rpc-contract.ts); the form stops the user before the host's generic validation error.
const MAX_SCOPES = 32;
const MAX_PATHS = 16;
const MAX_NAME = 128;
const MAX_PATH = 1024;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One card of the form. `picked` are the checked skill names, `patterns` the comma-separated globs. */
interface Card {
  key: number;
  name: string;
  paths: string[];
  picked: string[];
  patterns: string;
}

function trimmedList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

/** What Save sends: trimmed, without empty directory rows and empty patterns. Checked names come first. */
function toPayload(cards: Card[]): UiScope[] {
  return cards.map((card) => ({
    name: card.name.trim(),
    paths: trimmedList(card.paths),
    skills: [...card.picked, ...trimmedList(card.patterns.split(","))],
  }));
}

function sameCards(left: Card[], right: Card[]): boolean {
  return JSON.stringify(toPayload(left)) === JSON.stringify(toPayload(right));
}

/** Any difference a user made, including empty rows and spaces; keys are not compared. */
function sameRawCards(left: Card[], right: Card[]): boolean {
  const raw = (cards: Card[]) =>
    JSON.stringify(
      cards.map(({ name, paths, picked, patterns }) => ({ name, paths, picked, patterns })),
    );
  return raw(left) === raw(right);
}

function SectionNote(props: { children: string; id?: string }) {
  return (
    <div id={props.id} style={{ fontSize: 12, color: SOFT_INK }}>
      {props.children}
    </div>
  );
}

function FileScopes(props: { scopes: FileScope[] }) {
  if (props.scopes.length === 0) return <p style={{ color: SOFT_INK }}>None.</p>;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {props.scopes.map((scope) => (
        <li key={scope.name} style={{ padding: "8px 0", borderTop: RULE }}>
          <div>
            <strong style={{ color: "var(--ink)" }}>{scope.name}</strong>{" "}
            <span style={{ fontSize: 12, color: SOFT_INK }}>{scope.source}</span>
          </div>
          <SectionNote>{`Directories: ${scope.paths.join(", ")}`}</SectionNote>
          <SectionNote>{`Skills: ${scope.skills.join(", ")}`}</SectionNote>
          {scope.hasProfile ? <SectionNote>{PROFILE_NOTE}</SectionNote> : null}
          {scope.replacedByUi ? <SectionNote>replaced by your scope</SectionNote> : null}
        </li>
      ))}
    </ul>
  );
}

function ScopeCard(props: {
  card: Card;
  position: number;
  snapshot: ScopesSnapshot;
  onChange: (patch: Partial<Card>) => void;
  onRemove: () => void;
  onAddPath: () => void;
  onRemovePath: (index: number) => void;
}) {
  const { card, position, snapshot, onChange, onRemove, onAddPath, onRemovePath } = props;
  const base = useId();
  const label = card.name.trim() === "" ? `New scope ${position}` : card.name.trim();
  const fileScope = snapshot.fileScopes.find((file) => file.name === card.name.trim());
  const ignored = fileScope?.hasProfile === true || snapshot.skipped.includes(card.name.trim());
  const noteId = `${base}-note`;
  const hintId = `${base}-hint`;
  const patternsHintId = `${base}-patterns-hint`;
  const note = ignored
    ? IGNORED_NOTE
    : fileScope === undefined
      ? null
      : `replaces file scope ${fileScope.name}`;
  const toggle = (skill: string, checked: boolean) =>
    onChange({
      picked: checked ? [...card.picked, skill] : card.picked.filter((name) => name !== skill),
    });
  return (
    <fieldset style={{ margin: "0 0 12px", padding: 12, border: RULE, borderRadius: 8 }}>
      <legend style={{ color: "var(--ink)", fontWeight: 500 }}>{label}</legend>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div>
          <label htmlFor={`${base}-name`}>Name</label>
          <input
            id={`${base}-name`}
            data-focus={`name:${card.key}`}
            type="text"
            value={card.name}
            maxLength={MAX_NAME}
            aria-describedby={note === null ? undefined : noteId}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </div>
        {note === null ? null : <SectionNote id={noteId}>{note}</SectionNote>}
        <div>
          {card.paths.map((value, index) => (
            <div key={index} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label htmlFor={`${base}-dir-${index}`}>{`Directory ${index + 1}`}</label>
              <input
                id={`${base}-dir-${index}`}
                data-focus={`dir:${card.key}:${index}`}
                type="text"
                value={value}
                maxLength={MAX_PATH}
                aria-describedby={hintId}
                onChange={(event) =>
                  onChange({
                    paths: card.paths.map((path, at) => (at === index ? event.target.value : path)),
                  })
                }
              />
              <button
                type="button"
                aria-label={`Remove directory ${index + 1} from ${label}`}
                onClick={() => onRemovePath(index)}
              >
                Remove
              </button>
            </div>
          ))}
          <SectionNote id={hintId}>Absolute or ~/…</SectionNote>
          <button
            type="button"
            data-focus={`add-dir:${card.key}`}
            disabled={card.paths.length >= MAX_PATHS}
            onClick={onAddPath}
          >
            Add directory
          </button>
        </div>
        <fieldset style={{ margin: 0, padding: 8, border: RULE, borderRadius: 6 }}>
          <legend>Skills</legend>
          {snapshot.skills.map((skill, index) => {
            const id = `${base}-skill-${index}`;
            return (
              <div key={skill.name}>
                <input
                  id={id}
                  type="checkbox"
                  checked={card.picked.includes(skill.name)}
                  onChange={(event) => toggle(skill.name, event.target.checked)}
                />
                <label htmlFor={id}>
                  <span>{skill.name}</span>{" "}
                  <span style={{ fontSize: 12, color: SOFT_INK }}>{skill.description}</span>
                </label>
              </div>
            );
          })}
          <label htmlFor={`${base}-patterns`}>Extra patterns</label>
          <input
            id={`${base}-patterns`}
            type="text"
            value={card.patterns}
            aria-describedby={patternsHintId}
            onChange={(event) => onChange({ patterns: event.target.value })}
          />
          <SectionNote id={patternsHintId}>Globs such as docs-*, comma-separated</SectionNote>
        </fieldset>
        <div>
          <button type="button" aria-label={`Remove scope ${label}`} onClick={onRemove}>
            Remove scope
          </button>
        </div>
      </div>
    </fieldset>
  );
}

function LoadError(props: { error: string; onRetry: () => void }) {
  return (
    <div role="alert" style={{ color: "var(--destructive-text)" }}>
      <p>Could not load scopes: {props.error}</p>
      <button type="button" onClick={props.onRetry}>
        Retry
      </button>
    </div>
  );
}

function DirectoryScopes() {
  const rpc = useRpc<DirSkillsRpcContract>();
  const [snapshot, setSnapshot] = useState<ScopesSnapshot | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [loaded, setLoaded] = useState<Card[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const revisionRef = useRef(0);
  const nextKeyRef = useRef(0);
  const focusRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dirty = !sameCards(cards, loaded);
  // Any edit, even an empty row: this gates reloads, so Add directory is not undone by a window focus.
  const edited = !sameRawCards(cards, loaded);
  const editedRef = useRef(edited);
  const cardsRef = useRef(cards);

  useEffect(() => {
    editedRef.current = edited;
    cardsRef.current = cards;
  }, [edited, cards]);

  useEffect(() => {
    const target = focusRef.current;
    if (target === null) return;
    focusRef.current = null;
    const root = rootRef.current;
    const wanted = root?.querySelector<HTMLElement>(`[data-focus="${target}"]`);
    // A disabled target (Add scope at the limit) cannot take focus: fall back to the first card.
    if (wanted != null && !wanted.matches(":disabled")) wanted.focus();
    else root?.querySelector<HTMLElement>('[data-focus^="name:"]')?.focus();
  });

  /** Skill names that are in the plugin's skills/ dir go to checkboxes, every other entry to the patterns. */
  const apply = useCallback((result: ScopesSnapshot) => {
    const known = new Set(result.skills.map((skill) => skill.name));
    // The card at index i keeps its key, so a load or save does not remount the cards and drop focus.
    const next = result.uiScopes.map((scope, index) => ({
      key: cardsRef.current[index]?.key ?? nextKeyRef.current++,
      name: scope.name,
      paths: scope.paths,
      picked: scope.skills.filter((skill) => known.has(skill)),
      patterns: scope.skills.filter((skill) => !known.has(skill)).join(", "),
    }));
    setSnapshot(result);
    setCards(next);
    setLoaded(next);
  }, []);

  const load = useCallback(async () => {
    const revision = ++revisionRef.current;
    try {
      const result = await rpc.call("getScopes", null);
      // A newer load or a save supersedes this one; unsaved edits are never replaced.
      if (revision !== revisionRef.current || editedRef.current) return;
      apply(result);
      setLoadError(null);
    } catch (error) {
      if (revision !== revisionRef.current) return;
      setLoadError(describeError(error));
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
      const result = await rpc.call("saveScopes", { scopes: toPayload(cards) });
      // The save supersedes a load that started while it ran.
      revisionRef.current++;
      focusRef.current = "add-scope";
      apply(result);
      setSaved(true);
    } catch (error) {
      setSaveError(describeError(error));
    } finally {
      setSaving(false);
    }
  };

  const update = (key: number, patch: Partial<Card>) => {
    setSaved(false);
    setCards((current) => current.map((card) => (card.key === key ? { ...card, ...patch } : card)));
  };

  const addScope = () => {
    const key = nextKeyRef.current++;
    focusRef.current = `name:${key}`;
    setSaved(false);
    setCards((current) => [...current, { key, name: "", paths: [""], picked: [], patterns: "" }]);
  };

  const removeScope = (index: number) => {
    const next = cards[index + 1];
    focusRef.current = next === undefined ? "add-scope" : `name:${next.key}`;
    setSaved(false);
    setCards((current) => current.filter((_, at) => at !== index));
  };

  const addPath = (card: Card) => {
    focusRef.current = `dir:${card.key}:${card.paths.length}`;
    update(card.key, { paths: [...card.paths, ""] });
  };

  const removePath = (card: Card, index: number) => {
    focusRef.current =
      index < card.paths.length - 1 ? `dir:${card.key}:${index}` : `add-dir:${card.key}`;
    update(card.key, { paths: card.paths.filter((_, at) => at !== index) });
  };

  if (snapshot === null) {
    if (loadError === null) return <p style={{ color: SOFT_INK }}>Loading scopes…</p>;
    return <LoadError error={loadError} onRetry={() => void load()} />;
  }
  return (
    <div ref={rootRef} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {loadError === null ? null : <LoadError error={loadError} onRetry={() => void load()} />}
      {snapshot.settingError === null ? null : (
        <p style={{ color: "var(--destructive-text)" }}>
          {`Saved scopes could not be read and are ignored: ${snapshot.settingError}. Save to replace them.`}
        </p>
      )}
      <section aria-label="From files">
        <h4 style={{ margin: 0 }}>From files</h4>
        <FileScopes scopes={snapshot.fileScopes} />
      </section>
      <section aria-label="Your scopes">
        <h4 style={{ margin: "0 0 8px" }}>Your scopes</h4>
        <fieldset disabled={saving} style={{ margin: 0, padding: 0, border: "none" }}>
          {cards.map((card, index) => (
            <ScopeCard
              key={card.key}
              card={card}
              position={index + 1}
              snapshot={snapshot}
              onChange={(patch) => update(card.key, patch)}
              onRemove={() => removeScope(index)}
              onAddPath={() => addPath(card)}
              onRemovePath={(at) => removePath(card, at)}
            />
          ))}
          {saveError === null ? null : (
            <div role="alert" style={{ color: "var(--destructive-text)" }}>
              {saveError}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-focus="add-scope"
              disabled={cards.length >= MAX_SCOPES}
              onClick={addScope}
            >
              Add scope
            </button>
            <button
              type="button"
              disabled={(!dirty && snapshot.settingError === null) || saving}
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              type="button"
              disabled={!edited || saving}
              onClick={() => {
                focusRef.current = "add-scope";
                setCards(loaded);
                setSaveError(null);
              }}
            >
              Discard changes
            </button>
          </div>
        </fieldset>
        <output style={{ display: "block", margin: 0, fontSize: 12, color: SOFT_INK }}>
          {saved ? "Saved" : ""}
        </output>
      </section>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "scopes",
    title: "Directory scopes",
    description:
      "Give skills to threads that work under a directory. Scopes from your files are shown read-only; the scopes you save here replace a file scope of the same name, unless that scope has a Claude profile.",
    component: DirectoryScopes,
  });
});
