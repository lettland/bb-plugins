import { afterEach, describe, expect, test, vi } from "vitest";

import {
  agentBrand,
  formatAbsolute,
  formatReasoningLevel,
  formatShortWhen,
  formatWhen,
  fromDatetimeLocal,
  isPending,
  isTaskRunning,
  localDateAt,
  needsAttention,
  nextScheduleTime,
  presentRunState,
  providerLabel,
  runStateLabel,
  stageTone,
  supportsTaskRead,
  titleFromPrompt,
  toDatetimeLocal,
  type RunPresentation,
} from "../../lib/triage-format.ts";
import type { Stage, Task } from "../../lib/triage-types.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    number: 1,
    title: "Task 1",
    description: "",
    stageId: "stage-progress",
    projectId: "p",
    projectName: "Project",
    machineId: null,
    machineName: "Default",
    branchName: "main",
    providerId: "claude-code",
    model: "test-model",
    reasoningLevel: "none",
    scheduledAt: null,
    threadId: null,
    runState: "idle",
    attentionReason: null,
    request: null,
    readAt: null,
    settledAt: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function stage(systemRole: Stage["systemRole"]): Stage {
  return { id: `stage-${String(systemRole)}`, name: "Stage", position: 100, systemRole };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("relative stamps", () => {
  test("formatShortWhen collapses under a minute, minutes, hours, and days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00"));
    const now = Date.now();
    expect(formatShortWhen(now - 10_000)).toBe("now");
    expect(formatShortWhen(now + 10_000)).toBe("now");
    expect(formatShortWhen(now - 3 * MINUTE)).toBe("3m");
    expect(formatShortWhen(now + 3 * MINUTE)).toBe("in 3m");
    expect(formatShortWhen(now - 2 * HOUR)).toBe("2h");
    expect(formatShortWhen(now + 2 * HOUR)).toBe("in 2h");
    expect(formatShortWhen(now - 3 * DAY)).toBe("3d");
    expect(formatShortWhen(now + 3 * DAY)).toBe("in 3d");
  });

  test("formatShortWhen falls back to a month-day stamp a week out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00"));
    const later = Date.now() + 30 * DAY;
    expect(formatShortWhen(later)).toBe(
      new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(later)),
    );
    const earlier = Date.now() - 30 * DAY;
    expect(formatShortWhen(earlier)).toBe(
      new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(earlier)),
    );
  });

  test("formatWhen words the under-a-minute window by direction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00"));
    const now = Date.now();
    expect(formatWhen(now - 5_000)).toBe("just now");
    expect(formatWhen(now + 5_000)).toBe("in under a minute");
    expect(formatWhen(now - 5 * MINUTE)).toBe("5m ago");
    expect(formatWhen(now + 5 * MINUTE)).toBe("in 5m");
  });

  test("formatWhen and formatAbsolute render absolute stamps past the hour window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00"));
    const stamp = Date.now() - 3 * HOUR;
    expect(formatWhen(stamp)).toBe(
      new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
        new Date(stamp),
      ),
    );
    expect(formatAbsolute(stamp)).toBe(
      new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
        new Date(stamp),
      ),
    );
  });
});

describe("run and stage presentation", () => {
  test("presentRunState maps every run state", () => {
    const expected: Record<Task["runState"], RunPresentation> = {
      dispatching: { tone: "ongoing", label: "Dispatching", live: true },
      starting: { tone: "ongoing", label: "Starting", live: true },
      working: { tone: "ongoing", label: "Working", live: true },
      idle: { tone: "unread", label: "Waiting for you", live: false },
      scheduled: { tone: "scheduled", label: "Scheduled", live: false },
      queued: { tone: "pending", label: "Ready to run", live: false },
      failed: { tone: "danger", label: "Failed", live: false },
      stopped: { tone: "danger", label: "Stopped", live: false },
      completed: { tone: "done", label: "Completed", live: false },
    };
    for (const [runState, presentation] of Object.entries(expected)) {
      expect(presentRunState(task({ runState: runState as Task["runState"] }))).toStrictEqual(presentation);
    }
  });

  test("predicates split the run states along their board meanings", () => {
    expect(supportsTaskRead(task({ runState: "queued" }))).toBe(false);
    expect(supportsTaskRead(task({ runState: "scheduled" }))).toBe(false);
    expect(supportsTaskRead(task({ runState: "working" }))).toBe(true);
    expect(isTaskRunning(task({ runState: "dispatching" }))).toBe(true);
    expect(isTaskRunning(task({ runState: "starting" }))).toBe(true);
    expect(isTaskRunning(task({ runState: "working" }))).toBe(true);
    expect(isTaskRunning(task({ runState: "idle" }))).toBe(false);
    expect(isPending(task({ runState: "queued" }))).toBe(true);
    expect(isPending(task({ runState: "scheduled" }))).toBe(true);
    expect(isPending(task({ runState: "completed" }))).toBe(false);
  });

  test("needsAttention follows the run state and the stored reason", () => {
    expect(needsAttention(task({ runState: "idle" }))).toBe(true);
    expect(needsAttention(task({ runState: "failed" }))).toBe(true);
    expect(needsAttention(task({ runState: "working", attentionReason: "needs access" }))).toBe(true);
    expect(needsAttention(task({ runState: "working" }))).toBe(false);
  });

  test("stageTone colours by workflow role, neutral for user stages", () => {
    expect(stageTone(stage("intake"))).toBe("pending");
    expect(stageTone(stage("active"))).toBe("ongoing");
    expect(stageTone(stage("attention"))).toBe("danger");
    expect(stageTone(stage("done"))).toBe("done");
    expect(stageTone(stage(null))).toBe("neutral");
  });
});

describe("agent branding", () => {
  test("prototype keys never masquerade as provider brands", () => {
    // The provider table is keyed by wire strings; an inherited
    // Object.prototype member must fall through to the generic brand.
    expect(agentBrand("constructor", "unmatched-model")).toStrictEqual(agentBrand("any-provider", "unmatched-model"));
    expect(agentBrand("__proto__", "unmatched-model")).toStrictEqual(agentBrand("any-provider", "unmatched-model"));
  });

  test("model families win over the provider table", () => {
    expect(agentBrand("any-provider", "gpt-5")).toStrictEqual({ icon: "BrandOpenAi", name: "OpenAI" });
    expect(agentBrand("any-provider", "codex-mini")).toStrictEqual({ icon: "BrandOpenAi", name: "OpenAI" });
    expect(agentBrand("any-provider", "openai/o3")).toStrictEqual({ icon: "BrandOpenAi", name: "OpenAI" });
    expect(agentBrand("any-provider", "o1-preview")).toStrictEqual({ icon: "BrandOpenAi", name: "OpenAI" });
    expect(agentBrand("any-provider", "claude-sonnet-5")).toStrictEqual({ icon: "BrandClaude", name: "Anthropic" });
    expect(agentBrand("any-provider", "opus")).toStrictEqual({ icon: "BrandClaude", name: "Anthropic" });
    expect(agentBrand("any-provider", "sonnet")).toStrictEqual({ icon: "BrandClaude", name: "Anthropic" });
    expect(agentBrand("any-provider", "haiku")).toStrictEqual({ icon: "BrandClaude", name: "Anthropic" });
    expect(agentBrand("any-provider", "fable")).toStrictEqual({ icon: "BrandClaude", name: "Anthropic" });
    expect(agentBrand("any-provider", "deepseek-chat")).toStrictEqual({ icon: "BrandDeepseek", name: "DeepSeek" });
    expect(agentBrand("any-provider", "gemini-3")).toStrictEqual({ icon: "BrandGemini", name: "Google" });
    expect(agentBrand("any-provider", "gemma")).toStrictEqual({ icon: "BrandGemini", name: "Google" });
    expect(agentBrand("any-provider", "grok-4")).toStrictEqual({ icon: "BrandGrok", name: "xAI" });
    expect(agentBrand("any-provider", "qwen-max")).toStrictEqual({ icon: "BrandQwen", name: "Qwen" });
    expect(agentBrand("any-provider", "mistral-large")).toStrictEqual({ icon: "BrandMistral", name: "Mistral" });
    expect(agentBrand("any-provider", "magistral")).toStrictEqual({ icon: "BrandMistral", name: "Mistral" });
    expect(agentBrand("any-provider", "devstral")).toStrictEqual({ icon: "BrandMistral", name: "Mistral" });
    expect(agentBrand("any-provider", "codestral")).toStrictEqual({ icon: "BrandMistral", name: "Mistral" });
    expect(agentBrand("any-provider", "llama-4")).toStrictEqual({ icon: "BrandMeta", name: "Meta" });
    expect(agentBrand("any-provider", "copilot-worker")).toStrictEqual({ icon: "BrandCopilot", name: "GitHub Copilot" });
    expect(agentBrand("any-provider", "sonar-pro")).toStrictEqual({ icon: "BrandPerplexity", name: "Perplexity" });
    expect(agentBrand("any-provider", "perplexity")).toStrictEqual({ icon: "BrandPerplexity", name: "Perplexity" });
  });

  test("unknown models fall back to the provider, then the generic mark", () => {
    expect(agentBrand("codex", "house-model")).toStrictEqual({ icon: "BrandOpenAi", name: "OpenAI" });
    expect(agentBrand("claude-code", "house-model")).toStrictEqual({ icon: "BrandClaude", name: "Anthropic" });
    expect(agentBrand("acp-grok", "house-model")).toStrictEqual({ icon: "BrandGrok", name: "xAI" });
    expect(agentBrand("acp-echo", "house-model")).toStrictEqual({ icon: "AiContentGenerator01", name: "Agent" });
  });
});

describe("labels", () => {
  test("providerLabel splits on separators and drops empty parts", () => {
    expect(providerLabel("claude-code")).toBe("Claude Code");
    expect(providerLabel("acp_grok")).toBe("Acp Grok");
    expect(providerLabel("-codex-")).toBe("Codex");
  });

  test("reasoning levels and run states read as phrases", () => {
    expect(formatReasoningLevel("none")).toBe("No thinking");
    expect(formatReasoningLevel("xhigh")).toBe("Extra-high thinking");
    expect(formatReasoningLevel("ultra")).toBe("Ultra thinking");
    // Levels triage does not know fall back to the raw provider string —
    // including inherited Object.prototype keys, which must not defeat the
    // fallback (the label table is keyed by wire strings).
    expect(formatReasoningLevel("adaptive")).toBe("adaptive");
    expect(formatReasoningLevel("constructor")).toBe("constructor");
    expect(formatReasoningLevel("__proto__")).toBe("__proto__");
    expect(runStateLabel("queued")).toBe("Ready");
    expect(runStateLabel("idle")).toBe("Waiting for you");
    expect(runStateLabel("stopped")).toBe("Stopped");
  });

  test("titleFromPrompt takes the first non-blank line, clipped", () => {
    expect(titleFromPrompt("\n \n  do the thing  \nsecond line")).toBe("do the thing");
    expect(titleFromPrompt("x".repeat(200)).length).toBe(160);
    expect(titleFromPrompt("   \n\t ")).toBe("");
  });
});

describe("schedule helpers", () => {
  test("toDatetimeLocal and fromDatetimeLocal round-trip a local wall time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00"));
    expect(toDatetimeLocal(null)).toBe("");
    const stamp = new Date(2026, 5, 20, 14, 30).getTime();
    expect(toDatetimeLocal(stamp)).toBe("2026-06-20T14:30");
    expect(fromDatetimeLocal("")).toBe(null);
    expect(fromDatetimeLocal("2026-06-20T14:30")).toBe(stamp);
    expect(() => fromDatetimeLocal("not-a-date")).toThrow("Choose a valid date and time");
  });

  test("nextScheduleTime lands on a quarter hour inside the next hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:07:00"));
    const next = nextScheduleTime();
    expect(next).toBeGreaterThan(Date.now());
    expect(new Date(next).getMinutes() % 15).toBe(0);
    expect(new Date(next).getSeconds()).toBe(0);
    expect(new Date(next).getMilliseconds()).toBe(0);
    expect(next - Date.now()).toBeLessThanOrEqual(HOUR + 15 * MINUTE);
  });

  test("localDateAt pushes a past slot on the given day to tomorrow", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00"));
    const futureToday = localDateAt(11, 30, 0);
    expect(new Date(futureToday).getDate()).toBe(15);
    expect(futureToday).toBeGreaterThan(Date.now());
    const pastToday = localDateAt(9, 0, 0);
    expect(new Date(pastToday).getDate()).toBe(16);
    expect(pastToday).toBeGreaterThan(Date.now());
    const offsetDay = localDateAt(23, 59, 1);
    expect(new Date(offsetDay).getDate()).toBe(16);
    expect(offsetDay).toBeGreaterThan(Date.now());
  });
});
