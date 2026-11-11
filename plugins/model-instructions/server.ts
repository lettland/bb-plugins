import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { budgetReport, cacheProblem, describeType, type Role } from "./src/budget.js";
import { runCli, type OverBudgetRecord, type OverflowEvent } from "./src/cli.js";
import { buildScope, type Scope } from "./src/paths.js";
import { createCaches } from "./src/projects.js";
import {
  parseConfig,
  resolve,
  ruleLabel,
  unresolvedRefs,
  type Config,
} from "./src/rules.js";
import { createRulesSettingSchema } from "./src/settings.js";
import { loadSkills, type SkillEntry } from "./src/skills.js";

const OVERFLOW_EVENTS_KEPT = 20;

function pluginRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === "dist" ? path.dirname(here) : here;
}

export default async function plugin(bb: BbPluginApi) {
  let skills: SkillEntry[] = [];
  try {
    skills = loadSkills(path.join(pluginRoot(), "skills"));
  } catch (error) {
    bb.log.warn(
      `bundled skills not loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const skillNames = () => skills.map((skill) => skill.name);

  let config: Config = { rules: [], scopes: [] };
  let scopes: Scope[] = [];
  const overBudget = new Map<string, OverBudgetRecord>();
  const overflowSeen = new Set<string>();
  const overflowEvents: OverflowEvent[] = [];

  /** Names the thread types that are over the limit now; logs the ones that were not before. */
  function recheckBudget(): void {
    const snapshot = caches.snapshot();
    if (cacheProblem(snapshot) !== null) return;
    const { overflowing } = budgetReport(config.rules, scopes, snapshot);
    const current = new Map(
      overflowing.map((type) => [
        JSON.stringify([type.provider, type.model, type.role, type.project]),
        type,
      ]),
    );
    for (const key of [...overBudget.keys()])
      if (!current.has(key)) overBudget.delete(key);
    for (const [key, type] of current) {
      if (overBudget.has(key)) continue;
      overBudget.set(key, { ...type, since: new Date().toISOString() });
      bb.log.warn(
        `over budget: ${describeType(type)}; the rules would be cut at runtime`,
      );
    }
  }

  const caches = createCaches(bb, recheckBudget);

  const settings = bb.settings.define({
    rules: {
      type: "string",
      label: "Rules",
      description:
        'JSON array of rules, or an object { "vars"?, "scopes"?, "rules" }. See the plugin README; run `bb model-instructions status` to inspect and `bb model-instructions check` to try a thread.',
      experimental_multiline: true,
      experimental_schema: createRulesSettingSchema({
        skillNames,
        // Another source of scopes (a file) plugs in here.
        scopesFor: (own) => own,
        caches: () => caches.snapshot(),
      }),
      default: "[]",
    },
  });

  function load(json: string): void {
    try {
      config = parseConfig(json);
      scopes = config.scopes.map((scope) => buildScope(scope));
    } catch (error) {
      config = { rules: [], scopes: [] };
      scopes = [];
      bb.log.warn(
        // v8 ignore next -- @preserve parseConfig only throws Error, so the non-Error arm is unreachable.
        `rules setting ignored: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    bb.log.info(
      `loaded ${config.rules.length} rule(s), ${scopes.length} scope(s)`,
    );
    const unresolved = new Map<number, string[]>();
    for (const ref of unresolvedRefs(
      config.rules,
      scopes.map((scope) => scope.name),
      skillNames(),
    )) {
      const list = unresolved.get(ref.index) ?? [];
      list.push(`${ref.kind} "${ref.glob}"`);
      unresolved.set(ref.index, list);
    }
    for (const [index, refs] of unresolved)
      bb.log.warn(
        `${ruleLabel(config.rules[index], index)}: ${refs.join(", ")} match nothing`,
      );
  }

  load((await settings.get()).rules);
  settings.onChange((next) => {
    load(next.rules);
    recheckBudget();
  });
  await caches.refresh();

  bb.agents.configure((context) => {
    const role: Role = context.thread.parentThreadId === null ? "top-level" : "child";
    const resolved = resolve(config.rules, scopes, skillNames(), {
      provider: context.provider.id,
      model: context.provider.model,
      project: context.project.name,
      parentThreadId: context.thread.parentThreadId,
      title: context.thread.title,
      candidatePaths: caches.candidatesFor(
        context.environment.path,
        context.project.id,
      ),
    });
    if (resolved.dropped.length > 0) {
      const key = JSON.stringify([context.thread.id, resolved.dropped]);
      if (!overflowSeen.has(key)) {
        overflowSeen.add(key);
        bb.log.warn(
          `thread ${context.thread.id} (${context.provider.id} ${context.provider.model}, ${role}) lost rules over the limit: ${resolved.dropped.join(", ")}`,
        );
        overflowEvents.push({
          time: new Date().toISOString(),
          threadId: context.thread.id,
          provider: context.provider.id,
          model: context.provider.model,
          role,
          project: context.project.name,
          dropped: resolved.dropped,
          lengths: resolved.droppedLengths,
        });
        if (overflowEvents.length > OVERFLOW_EVENTS_KEPT)
          overflowEvents.shift();
      }
    }
    return {
      tools: [],
      skills: resolved.skills,
      ...(resolved.text === null ? {} : { instructions: resolved.text }),
    };
  });

  bb.cli.register({
    name: "model-instructions",
    summary: "Show the instruction rules and check what a thread would receive",
    commands: [
      {
        name: "status",
        summary: "List scopes, rules, skills, the cache state and overflows",
        usage: "bb model-instructions status [--json]",
      },
      {
        name: "check",
        summary: "Show the rules, length and skills a thread would get",
        usage:
          "bb model-instructions check [--provider P] [--model M] [--child] [--project <id>] [--path <dir>] [--title T] [--json] | check --all [--json]",
      },
    ],
    run: (argv, ctx) =>
      runCli(argv, ctx, {
        rules: () => config.rules,
        scopes: () => scopes,
        skills: () => skills,
        caches,
        overBudget: () => [...overBudget.values()],
        events: () => overflowEvents,
        threads: bb.sdk.threads,
      }),
  });
}
