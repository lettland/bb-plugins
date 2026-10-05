import { rankSkills } from "./rank.mjs";
import { loadSkill } from "./loader.mjs";

const REVIEW_MODES = new Set(["code", "impl", "plan"]);
// A review target (a git range or a path): printable, no control chars/newlines, bounded — so it
// cannot smuggle instruction text into an auto-injected thread turn.
const TARGET_RE = /^[^\u0000-\u001f\u007f]{1,200}$/u;

const USAGE = [
  "Usage: bb devkit <command>",
  "  commands                                           List the ported devkit command workflows",
  "  run <command> [args...]                            Run a command workflow (injects a turn, else prints instructions)",
  "  review <code | impl <base>..<head> | plan <path>>  Run the calibrated review (injects a turn, else prints instructions; plan always prints)",
  "  skills list                                        List every devkit skill (slug: description)",
  "  skills find <topic>                                Rank skills relevant to a topic",
  "  skills show <slug>                                 Print one skill body",
].join("\n");

const AGENT_NOTE_REVIEW =
  "[devkit review — instructions for a coding agent to run; this prints the workflow, it does not produce the review itself]";
// A plan review ends at the user's approval, never at implementation.
const PLAN_STOP = [
  "Plan scope: edit only the plan document, never any other file, and do not start implementing.",
  "When the plan is revised, stop and get the user's approval: if you are no longer in plan mode and your provider can re-enter it (Claude Code: EnterPlanMode), re-enter it first,",
  "then present the revised plan for approval (Claude Code: ExitPlanMode) with a short summary of what the review changed.",
  "Without a plan-approval tool, end your turn with the revised plan and wait. Implement only after the user explicitly approves.",
].join("\n");
const AGENT_NOTE_RUN =
  "[devkit command — instructions for a coding agent to run; devkit_load_skill is an agent tool call, not a shell command]";

function reviewInstruction(mode, target) {
  const scope = mode === "code"
    ? "the uncommitted changes in this checkout"
    : mode === "impl"
      ? `the diff for range ${target}`
      : `the plan document at ${target}`;
  const lines = [
    AGENT_NOTE_REVIEW,
    "",
    `Run the devkit calibrated review over ${scope}.`,
    "Load the workflow with devkit_load_skill({ slug: \"review-code\" }) and follow it:",
    "apply the four reviewer lenses, consolidate into Blockers/Concerns/Advisories/Verdict, then disposition.",
  ];
  if (mode === "plan") lines.push("", PLAN_STOP);
  return lines.join("\n");
}

/** Inject the instruction as a thread turn when possible, else print it. Never throws. */
async function dispatch(instruction, requestedMessage, deps) {
  if (deps.injectInstruction !== undefined) {
    let injected = false;
    try {
      injected = await deps.injectInstruction(instruction);
    } catch {
      injected = false;
    }
    if (injected) return { exitCode: 0, stdout: requestedMessage };
  }
  return { exitCode: 0, stdout: `${instruction}\n` };
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Validate the review target for `impl`/`plan`; returns an error result or undefined. */
function validateReviewTarget(mode, target) {
  if (target === undefined || target.length === 0) {
    return { exitCode: 2, stderr: `review ${mode} needs ${mode === "impl" ? "<base>..<head>" : "<path>"}\n` };
  }
  if (!TARGET_RE.test(target)) {
    return { exitCode: 2, stderr: `review ${mode}: invalid target (max 200 printable characters, no newlines)\n` };
  }
  if (mode === "impl") {
    const parts = target.split("..");
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
      return { exitCode: 2, stderr: `review impl needs a range like <base>..<head> (got '${target}')\n` };
    }
  }
  return undefined;
}

function runReview(rest, deps) {
  const [mode, target] = rest;
  if (mode === undefined || !REVIEW_MODES.has(mode)) {
    return { exitCode: 2, stderr: "review needs a mode: code | impl <base>..<head> | plan <path>\n" };
  }
  if (mode === "impl" || mode === "plan") {
    const invalid = validateReviewTarget(mode, target);
    if (invalid !== undefined) return invalid;
  }
  // A plan review is printed, never injected: an injected turn carries the thread's permission
  // mode, which takes the agent out of plan mode, so its next plan presentation is approved
  // without ever reaching the user. Printed, the agent follows it in its current turn.
  if (mode === "plan") return { exitCode: 0, stdout: `${reviewInstruction(mode, target)}\n` };
  return dispatch(
    reviewInstruction(mode, target),
    "Review requested — the coding agent will run it as the next turn in this thread.\n",
    deps,
  );
}

function listCommands(deps) {
  const cmds = deps.index.skills
    .filter((s) => s.slug.startsWith("cmd-"))
    .map((s) => `${s.slug.slice(4)}: ${s.description.replace(/^Command — /, "")}`)
    .sort(byText);
  if (cmds.length === 0) return { exitCode: 0, stdout: "No command workflows available.\n" };
  return { exitCode: 0, stdout: `Run one with 'bb devkit run <name>':\n${cmds.join("\n")}\n` };
}

function runCommand(rest, deps) {
  const [name, ...args] = rest;
  if (name === undefined) return { exitCode: 2, stderr: "run needs a command name (see 'bb devkit commands')\n" };
  const slug = `cmd-${name}`;
  if (!deps.index.skills.some((s) => s.slug === slug)) {
    return { exitCode: 1, stderr: `Unknown command '${name}'. See 'bb devkit commands'.\n` };
  }
  const argLine = args.join(" ").trim();
  const argNote = argLine.length > 0 && TARGET_RE.test(argLine) ? ` Arguments: ${argLine}.` : "";
  const instruction = `${AGENT_NOTE_RUN}\n\nLoad the devkit command workflow with devkit_load_skill({ slug: "${slug}" }) and follow it.${argNote}`;
  return dispatch(
    instruction,
    `Command '${name}' requested — the coding agent will run it as the next turn in this thread.\n`,
    deps,
  );
}

async function runSkills(rest, deps) {
  const [sub, ...args] = rest;
  if (sub === "list") {
    const lines = deps.index.skills.map((s) => `${s.slug}: ${s.description}`).sort(byText);
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  }
  if (sub === "find") {
    const topic = args.join(" ").trim();
    if (topic.length === 0) return { exitCode: 2, stderr: "skills find needs a topic\n" };
    const hits = rankSkills(deps.index.skills, topic, 15);
    if (hits.length === 0) return { exitCode: 0, stdout: `No devkit skill matched "${topic}".\n` };
    return { exitCode: 0, stdout: `${hits.map((h) => `${h.slug}: ${h.description}`).join("\n")}\n` };
  }
  if (sub === "show") {
    const slug = args[0];
    if (slug === undefined) return { exitCode: 2, stderr: "skills show needs a slug\n" };
    const result = await loadSkill(deps.dataRoot, slug);
    if (!result.ok) return { exitCode: 1, stderr: `${result.message}\n` };
    return { exitCode: 0, stdout: result.content.endsWith("\n") ? result.content : `${result.content}\n` };
  }
  return { exitCode: 2, stderr: `unknown skills subcommand.\n${USAGE}\n` };
}

/**
 * Dispatch a `bb devkit ...` invocation. Pure over its deps so it is unit-testable without bb.
 * @param {readonly string[]} argv argv with the top-level command name already stripped
 * @param {{ index: import("./rank.mjs").SkillIndex, dataRoot: string, injectInstruction?: (instruction: string) => Promise<boolean> }} deps
 * @returns {Promise<{ exitCode: number, stdout?: string, stderr?: string }>}
 */
export async function runDevkitCli(argv, deps) {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { exitCode: 0, stdout: `${USAGE}\n` };
  }
  if (command === "review") return runReview(rest, deps);
  if (command === "commands") return listCommands(deps);
  if (command === "run") return runCommand(rest, deps);
  if (command === "skills") return runSkills(rest, deps);
  return { exitCode: 2, stderr: `unknown command '${command}'.\n${USAGE}\n` };
}
