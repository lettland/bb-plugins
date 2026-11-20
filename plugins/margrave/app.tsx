import { useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { catalogErrors, catalogSchema, rpcContract } from "./contract.js";
import type { z } from "zod";

const control =
  "rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
type Skill = z.infer<typeof catalogSchema>["skills"][number];

function SkillResults({
  skills,
  matches,
  page,
  setPage,
}: {
  skills: Skill[];
  matches: Skill[];
  page: number;
  setPage: (page: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(matches.length / 25) - 1),
  );
  const first = currentPage * 25;

  function changePage(nextPage: number) {
    setPage(nextPage);
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }

  return (
    <section className="mt-4 flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div
          role="status"
          className="flex flex-wrap gap-x-3 text-muted-foreground"
        >
          <span>
            {matches.length} {matches.length === 1 ? "skill" : "skills"}
          </span>
          {matches.length > 0 && (
            <span>
              {first + 1}–{Math.min(first + 25, matches.length)} of{" "}
              {matches.length}
            </span>
          )}
        </div>
        {matches.length > 0 && (
          <div className="flex gap-2">
            <button
              className={control}
              disabled={currentPage === 0}
              onClick={() => changePage(currentPage - 1)}
            >
              Previous
            </button>
            <button
              className={control}
              disabled={first + 25 >= matches.length}
              onClick={() => changePage(currentPage + 1)}
            >
              Next
            </button>
          </div>
        )}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {skills.length === 0 ? (
          <p className="mt-4 text-sm">No skills installed in Margrave.</p>
        ) : matches.length === 0 ? (
          <p className="mt-4 text-sm">No skills match your filters.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {matches.slice(first, first + 25).map((skill) => (
              <li key={skill.id} className="min-w-0 py-3">
                <div className="break-words font-medium">{skill.name}</div>
                <div className="break-all font-mono text-xs text-muted-foreground">
                  {skill.id}
                </div>
                <p className="mt-1 break-words text-sm">{skill.description}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SkillsPage() {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "listSkills",
    input: null,
  });
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("");
  const [page, setPage] = useState(0);
  const skills = query.data?.ok ? query.data.skills : [];
  const sources = [
    ...new Set(skills.map((skill) => skill.id.split("/")[0] ?? "")),
  ].sort();
  const activeSource = source && sources.includes(source) ? source : "";
  const needle = search.toLowerCase();
  const matches = skills.filter(
    (skill) =>
      (!activeSource || skill.id.split("/")[0] === activeSource) &&
      [skill.name, skill.id, skill.description].some((text) =>
        text.toLowerCase().includes(needle),
      ),
  );
  const error = query.error
    ? catalogErrors.failed
    : query.data && !query.data.ok
      ? catalogErrors[query.data.error]
      : null;

  return (
    <main className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-1 flex-col p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Margrave skills</h1>
        <button
          className={control}
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching && query.data ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-sm">
          Search skills
          <input
            className={`${control} min-w-0 w-full`}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </label>
        <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm">
          Source
          <select
            className={`${control} max-w-full`}
            value={activeSource}
            onChange={(event) => {
              setSource(event.target.value);
              setPage(0);
            }}
          >
            <option value="">All sources</option>
            {sources.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <div role="alert" className="mt-4 text-sm text-destructive">
          <p>{error}</p>
          <button
            className={`${control} mt-2`}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        </div>
      ) : query.data === undefined ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          Loading Margrave skills…
        </p>
      ) : (
        <SkillResults
          skills={skills}
          matches={matches}
          page={page}
          setPage={setPage}
        />
      )}
    </main>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "margrave-skills",
    title: "Margrave",
    icon: "ListView",
    path: "skills",
    component: SkillsPage,
  });
});
