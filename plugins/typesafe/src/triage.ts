import { redact, type Answer, type Question } from "./client.js";

export const TRIAGE_KINDS = ["question", "small_change", "heavy_change"] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];

export const TRIAGE_TIMEOUT_MS = 1500;
export const TRIAGE_STATE_MAX_CHARS = 8000;
export const TRIAGE_STORE_CAP = 500;

export const TRIAGE_QUESTIONS: Record<"kind" | "needs_plan", Question> = {
  kind: {
    type: "choice",
    instructions: "Classify the user's opening request to this thread.",
    criteria: {
      question: "A question, discussion, or lookup — no code or config change is requested",
      small_change: "A small, contained change or task — a fix, tweak, or single-area edit",
      heavy_change: "Substantial work — a new feature, refactor, audit, or multi-file/multi-area change",
    },
  },
  needs_plan: {
    type: "noul",
    instructions:
      "Does this opening request need a plan, design, or research step before implementation starts?",
  },
};

export interface TriageEntry {
  kind: TriageKind;
  p: number;
  conf: number;
  plan: number;
}

/** Redacted, then truncated — only fixed questions and clamped numbers leave the process. */
export function triageState(text: string): string {
  return redact(text).slice(0, TRIAGE_STATE_MAX_CHARS);
}

/** Validates the fixed triage questions' answers into the clamped entry, or null. */
export function buildTriageEntry(answers: Record<string, Answer>): TriageEntry | null {
  const kindAnswer = answers.kind;
  if (kindAnswer === undefined || kindAnswer.type !== "choice") return null;
  if (!(TRIAGE_KINDS as readonly string[]).includes(kindAnswer.choice)) return null;
  const p = kindAnswer.probabilities[kindAnswer.choice];
  if (typeof p !== "number") return null;
  const planAnswer = answers.needs_plan;
  if (planAnswer === undefined || planAnswer.type !== "noul") return null;
  return {
    kind: kindAnswer.choice as TriageKind,
    p,
    conf: kindAnswer.confidence,
    plan: planAnswer.noul,
  };
}

/** In-memory triage results per thread, capped oldest-first. */
export class TriageStore {
  readonly #entries = new Map<string, TriageEntry>();

  has(threadId: string): boolean {
    return this.#entries.has(threadId);
  }

  set(threadId: string, entry: TriageEntry): void {
    this.#entries.set(threadId, entry);
    if (this.#entries.size > TRIAGE_STORE_CAP) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }
  }

  /** The fixed-format advisory line for a thread, or null when it has no entry. */
  line(threadId: string): string | null {
    const entry = this.#entries.get(threadId);
    if (entry === undefined) return null;
    return `TypeSafe triage of this thread's opening request (advisory): ${entry.kind} (p=${entry.p.toFixed(2)}, conf ${entry.conf.toFixed(2)}); plan first p=${entry.plan.toFixed(2)}. Later decisions: call typesafe_decide.`;
  }
}
