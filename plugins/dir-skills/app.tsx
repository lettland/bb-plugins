import { useCallback, useEffect, useId, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { DirSkillsRpcContract, FileScope, ScopesSnapshot, UiScope } from "./rpc-contract";

const SOFT_INK = "color-mix(in oklch, var(--ink) 68%, var(--canvas))";
const RULE = "1px solid color-mix(in oklch, var(--ink) 11%, var(--canvas))";
const PROFILE_NOTE = "Claude profile — edit in ~/.bb/dir-skills/scopes.json";
const IGNORED_NOTE =
  "will be ignored: a scope with a Claude profile can only be changed in ~/.bb/dir-skills/scopes.json";

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

function SectionNote(props: { children: string }) {
  return <div style={{ fontSize: 12, color: SOFT_INK }}>{props.children}</div>;
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
            maxLength={128}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </div>
        {ignored ? (
          <SectionNote>{IGNORED_NOTE}</SectionNote>
        ) : fileScope === undefined ? null : (
          <SectionNote>{`replaces file scope ${fileScope.name}`}</SectionNote>
        )}
        <div>
          {card.paths.map((value, index) => (
            <div key={index} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label htmlFor={`${base}-dir-${index}`}>{`Directory ${index + 1}`}</label>
              <input
                id={`${base}-dir-${index}`}
                data-focus={`dir:${card.key}:${index}`}
                type="text"
                value={value}
                maxLength={1024}
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
          <SectionNote>Absolute or ~/…</SectionNote>
          <button type="button" data-focus={`add-dir:${card.key}`} onClick={onAddPath}>
            Add directory
          </button>
        </div>
        <fieldset style={{ margin: 0, padding: 8, border: RULE, borderRadius: 6 }}>
          <legend>Skills</legend>
          {snapshot.skills.map((skill) => {
            const id = `${base}-skill-${skill.name}`;
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
            onChange={(event) => onChange({ patterns: event.target.value })}
          />
          <SectionNote>Globs such as docs-*, comma-separated</SectionNote>
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
  const dirtyRef = useRef(dirty);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    const target = focusRef.current;
    if (target === null) return;
    focusRef.current = null;
    rootRef.current?.querySelector<HTMLElement>(`[data-focus="${target}"]`)?.focus();
  });

  /** Skill names that are in the plugin's skills/ dir go to checkboxes, every other entry to the patterns. */
  const apply = useCallback((result: ScopesSnapshot) => {
    const known = new Set(result.skills.map((skill) => skill.name));
    const next = result.uiScopes.map((scope) => ({
      key: nextKeyRef.current++,
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
      if (revision !== revisionRef.current || dirtyRef.current) return;
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
      if (!dirtyRef.current) void load();
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
          Saved scopes could not be read and are ignored: {snapshot.settingError}
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
            <button type="button" data-focus="add-scope" onClick={addScope}>
              Add scope
            </button>
            <button type="button" disabled={!dirty || saving} onClick={() => void save()}>
              Save
            </button>
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => {
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
