import type { IconName } from "../components/ui/icon";
import type { StatusTone } from "../components/ui/status-dot";
import type { ReasoningLevel, RunState, Stage, Task } from "./triage-types";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Compact relative stamp for dense surfaces: "3m", "2h", "Mar 4". */
export function formatShortWhen(timestamp: number): string {
  const delta = timestamp - Date.now();
  const absolute = Math.abs(delta);
  if (absolute < MINUTE) return "now";
  if (absolute < HOUR) {
    const minutes = Math.round(absolute / MINUTE);
    return delta > 0 ? `in ${minutes}m` : `${minutes}m`;
  }
  if (absolute < DAY) {
    const hours = Math.round(absolute / HOUR);
    return delta > 0 ? `in ${hours}h` : `${hours}h`;
  }
  if (absolute < 7 * DAY) {
    const days = Math.round(absolute / DAY);
    return delta > 0 ? `in ${days}d` : `${days}d`;
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(timestamp),
  );
}

/** Conversational relative stamp for prose: "3m ago", "in 2 hours". */
export function formatWhen(timestamp: number): string {
  const delta = timestamp - Date.now();
  const absolute = Math.abs(delta);
  if (absolute < MINUTE) return delta > 0 ? "in under a minute" : "just now";
  if (absolute < HOUR) {
    const minutes = Math.round(absolute / MINUTE);
    return delta > 0 ? `in ${minutes}m` : `${minutes}m ago`;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

/** Full stamp with weekday, used where a card's schedule must be unambiguous. */
export function formatAbsolute(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export interface RunPresentation {
  tone: StatusTone;
  /** Short status phrase for the card footer. */
  label: string;
  /** True while an agent is actively producing work. */
  live: boolean;
}

/**
 * One place that turns a run state into what the board shows. "Idle" is
 * deliberately never surfaced as a label — an idle agent means the card is
 * waiting on a person, and that is what the card should say.
 */
export function presentRunState(task: Task): RunPresentation {
  switch (task.runState) {
    case "dispatching":
      return { tone: "ongoing", label: "Dispatching", live: true };
    case "starting":
      return { tone: "ongoing", label: "Starting", live: true };
    case "working":
      return { tone: "ongoing", label: "Working", live: true };
    case "idle":
      return { tone: "unread", label: "Waiting for you", live: false };
    case "scheduled":
      return { tone: "scheduled", label: "Scheduled", live: false };
    case "queued":
      return { tone: "pending", label: "Ready to run", live: false };
    case "failed":
      return { tone: "danger", label: "Failed", live: false };
    case "stopped":
      return { tone: "danger", label: "Stopped", live: false };
    case "completed":
      return { tone: "done", label: "Completed", live: false };
  }
}

/** Queued and scheduled work has no agent update to read yet. */
export function supportsTaskRead(task: Pick<Task, "runState">): boolean {
  return task.runState !== "queued" && task.runState !== "scheduled";
}

export function isTaskRunning(task: Task): boolean {
  return task.runState === "dispatching" || task.runState === "starting" || task.runState === "working";
}

/** Cards a person still owes something to. Drives the "Needs you" filter. */
export function needsAttention(task: Task): boolean {
  return (
    task.runState === "idle" ||
    task.runState === "failed" ||
    task.attentionReason !== null
  );
}

export function isPending(task: Task): boolean {
  return task.runState === "queued" || task.runState === "scheduled";
}

/** Column accent, matched to the stage's role in the workflow. */
export function stageTone(stage: Stage): StatusTone {
  switch (stage.systemRole) {
    case "intake":
      return "pending";
    case "active":
      return "ongoing";
    case "attention":
      return "danger";
    case "done":
      return "done";
    default:
      return "neutral";
  }
}

export interface AgentBrand {
  /** Brand mark drawn beside the agent label. */
  icon: IconName;
  /** Vendor the mark belongs to, for the mark's accessible name. */
  name: string;
}

const OPEN_AI: AgentBrand = { icon: "BrandOpenAi", name: "OpenAI" };
const ANTHROPIC: AgentBrand = { icon: "BrandClaude", name: "Anthropic" };
const GENERIC_AGENT: AgentBrand = { icon: "AiContentGenerator01", name: "Agent" };

/**
 * Model families, matched against the model id. A model says more about the
 * work than the runner does — the same provider drives several vendors — so
 * these are tried before the provider table.
 */
const MODEL_BRANDS: readonly (readonly [RegExp, AgentBrand])[] = [
  [/gpt|codex|openai|\bo[0-9]/, OPEN_AI],
  [/claude|opus|sonnet|haiku|fable/, ANTHROPIC],
  [/deepseek/, { icon: "BrandDeepseek", name: "DeepSeek" }],
  [/gemini|gemma/, { icon: "BrandGemini", name: "Google" }],
  [/grok/, { icon: "BrandGrok", name: "xAI" }],
  [/qwen/, { icon: "BrandQwen", name: "Qwen" }],
  [/mistral|magistral|devstral|codestral/, { icon: "BrandMistral", name: "Mistral" }],
  [/llama/, { icon: "BrandMeta", name: "Meta" }],
  [/copilot/, { icon: "BrandCopilot", name: "GitHub Copilot" }],
  [/sonar|perplexity/, { icon: "BrandPerplexity", name: "Perplexity" }],
];

/** Fallback for runners whose model id carries no recognizable family. */
const PROVIDER_BRANDS: Record<string, AgentBrand> = {
  codex: OPEN_AI,
  "claude-code": ANTHROPIC,
  "acp-grok": { icon: "BrandGrok", name: "xAI" },
};

/** The mark a card shows for the agent behind it. */
export function agentBrand(providerId: string, model: string): AgentBrand {
  const id = model.toLowerCase();
  for (const [pattern, brand] of MODEL_BRANDS) {
    if (pattern.test(id)) return brand;
  }
  return PROVIDER_BRANDS[providerId] ?? GENERIC_AGENT;
}

export function providerLabel(providerId: string): string {
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const REASONING_LABELS: Record<ReasoningLevel, string> = {
  none: "No thinking",
  low: "Low thinking",
  medium: "Medium thinking",
  high: "High thinking",
  xhigh: "Extra-high thinking",
  ultracode: "Ultracode thinking",
  max: "Max thinking",
  ultra: "Ultra thinking",
};

export function formatReasoningLevel(level: ReasoningLevel): string {
  return REASONING_LABELS[level];
}

export function runStateLabel(state: RunState): string {
  const labels: Record<RunState, string> = {
    queued: "Ready",
    scheduled: "Scheduled",
    dispatching: "Dispatching",
    starting: "Starting",
    working: "Working",
    idle: "Waiting for you",
    failed: "Failed",
    completed: "Completed",
    stopped: "Stopped",
  };
  return labels[state];
}

export function titleFromPrompt(prompt: string): string {
  const line = prompt.split("\n").map((part) => part.trim()).find(Boolean);
  return line ? line.slice(0, 160) : "";
}

export function toDatetimeLocal(timestamp: number | null): string {
  if (timestamp === null) return "";
  const offset = new Date(timestamp).getTimezoneOffset() * MINUTE;
  return new Date(timestamp - offset).toISOString().slice(0, 16);
}

export function fromDatetimeLocal(value: string): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Choose a valid date and time");
  return timestamp;
}

export function nextScheduleTime(): number {
  const date = new Date(Date.now() + HOUR);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  return date.getTime();
}

export function localDateAt(hour: number, minute: number, dayOffset: number): number {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
  return date.getTime();
}
