import { z } from "zod";

const TOKEN_PATTERNS = [
  // PEM key blocks; the bounded lazy class keeps adversarial input linear.
  "-----BEGIN [A-Z0-9 ]*KEY-----[\\s\\S]{0,8192}?-----END [A-Z0-9 ]*KEY-----",
  // Provider tokens: GitHub, OpenAI-style, Slack, AWS.
  "\\b(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})",
  "\\bsk-[A-Za-z0-9_-]{16,}",
  "\\bxox[a-z]-[A-Za-z0-9-]{10,}",
  "\\bAKIA[0-9A-Z]{16}",
  // Authorization headers.
  "\\bBearer\\s+[A-Za-z0-9._~+/=-]{8,}",
  // URL userinfo: group 1 keeps the scheme, the host after @ is untouched.
  "([a-z][a-z0-9+.-]*://)[^\\s/@]+@",
].join("|");

const SECRETS_PATTERN = new RegExp(TOKEN_PATTERNS, "g");

const KEY_VALUE_PATTERN =
  /(^|[^\w-])(\w*(?:key|token|secret|password))\s*=\s*("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi;

/** Replaces obvious secrets with REDACTED in one linear pass. */
export function redact(text: string): string {
  return text
    .replace(SECRETS_PATTERN, (match, scheme: string | undefined) =>
      scheme === undefined ? "REDACTED" : `${scheme}REDACTED@`,
    )
    .replace(KEY_VALUE_PATTERN, "$1$2=REDACTED");
}

function redactStrings<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactStrings(entry)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactStrings(entry)]),
    ) as T;
  }
  return value;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type QuestionMap = Record<string, Question>;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend: Record<string, string>;
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export type DecideError =
  | { kind: "no-key" }
  | { kind: "timeout" }
  | { kind: "http"; status: number }
  | { kind: "bad-response" };

export interface DecideSuccess {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

export type DecideOutcome = { kind: "ok"; value: DecideSuccess } | DecideError;

export interface DecideInput {
  state: string;
  questions: QuestionMap;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
}

export interface DecideDeps {
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

interface Attempt {
  status: number | null;
  outcome: DecideOutcome;
}

const finiteNumber = z.number().refine(Number.isFinite, "expected a finite number");
const unit = finiteNumber.transform((value) => Math.min(1, Math.max(0, value)));
const scoreValue = finiteNumber.transform((value) => Math.min(10, Math.max(0, value)));
const tokenCount = finiteNumber.transform((value) => Math.max(0, Math.trunc(value)));

const answerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    choice: z.string().min(1),
    confidence: unit,
    probabilities: z.record(z.string(), unit),
  }),
  z.object({
    type: z.literal("noul"),
    noul: unit,
  }),
  z.object({
    type: z.literal("score"),
    score: scoreValue,
    confidence: unit,
    probabilities: z.record(z.string(), unit),
    legend: z.record(z.string(), z.string()),
  }),
]);

const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: tokenCount, output_tokens: tokenCount }),
});

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

async function fetchAndParse(
  fetchFn: typeof fetch,
  body: string,
  input: DecideInput,
  signal: AbortSignal,
): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetchFn(TYPESAFE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal,
    });
  } catch {
    return { status: null, outcome: { kind: "bad-response" } };
  }
  if (!response.ok) {
    return { status: response.status, outcome: { kind: "http", status: response.status } };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { status: response.status, outcome: { kind: "bad-response" } };
  }
  const result = responseSchema.safeParse(parsed);
  if (!result.success) return { status: response.status, outcome: { kind: "bad-response" } };
  return { status: response.status, outcome: { kind: "ok", value: result.data } };
}

/** Asks the TypeSafe Jev model and returns typed, clamped answers. */
export async function decide(input: DecideInput, deps: DecideDeps = {}): Promise<DecideOutcome> {
  const fetchFn = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  if (input.apiKey === null) return { kind: "no-key" };
  const body = JSON.stringify({
    model: input.model,
    state: redact(input.state),
    questions: redactStrings(input.questions),
  });
  const startedAt = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let status: number | null = null;
  const timeout = new Promise<DecideOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, input.timeoutMs);
  });
  const attempt = fetchAndParse(fetchFn, body, input, controller.signal).then((result) => {
    status = result.status;
    return result.outcome;
  });
  let outcome: DecideOutcome;
  try {
    outcome = await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
  log(`typesafe status=${status ?? 0} duration=${Date.now() - startedAt}ms`);
  return outcome;
}
