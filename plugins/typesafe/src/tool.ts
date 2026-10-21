import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { decide, type Answer, type DecideError, type QuestionMap } from "./client.js";

export const TOOL_INSTRUCTIONS = `\`typesafe_decide\` asks TypeSafe's Jev model typed questions and returns calibrated probabilities. It is advisory: explicit user or brief requirements, and repository rules, always win over it.

Use it when a judgment call is genuinely uncertain and material:
- Choosing between approaches or options when several look viable.
- Sizing work before delegating or planning (small vs heavy).
- Proportionality check on a non-trivial change: ask a Score "how proportional is this change to the request?" and a Noul "does it add features, abstractions, or guards that were not requested?". Pass the request text and a short summary of the diff, never the raw diff.

Do not use it for exact rules, lookups, math, or anything code or tests can check deterministically.

Never put secrets, credentials, or \`.env\` contents in \`state\`; they are sent to api.typesafe.ai (US-hosted).

Act on a confident answer (confidence >= ~0.6, or a Noul clearly away from 0.5). Below that, use your own judgment and say you did.

Worked example - proportionality check:
{"state":"Request: add a logout button to the header. Change: new Button component, AuthContext refactor, 3 new files, telemetry hooks.","questions":{"proportional":{"type":"score","instructions":"How proportional is the change to the request?","criteria":["far beyond the request","somewhat beyond","proportional"]},"unrequested":{"type":"noul","instructions":"Does the change add features, abstractions, or guards that were not requested?"}}}
`;

const MAX_SERIALIZED_STATE = 16000;
const MAX_QUESTIONS = 8;
const MAX_INSTRUCTION_CHARS = 2000;
const MAX_CHOICE_OPTIONS = 12;
const MAX_SCORE_LEVELS = 10;
const TOOL_TIMEOUT_MS = 15000;
const MAX_ERROR_SUMMARY_CHARS = 300;

const stateSchema = z
  .union([z.string(), z.record(z.string(), z.unknown())], {
    error: "expected a string or a JSON object",
  })
  .transform((value) => (typeof value === "string" ? value : JSON.stringify(value)))
  .refine(
    (value) => value.length <= MAX_SERIALIZED_STATE,
    `serialized state must be at most ${MAX_SERIALIZED_STATE} characters`,
  );

const questionNameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const instructionsSchema = z.string().min(1).max(MAX_INSTRUCTION_CHARS);

const choiceQuestion = z
  .object({
    type: z.literal("choice"),
    instructions: instructionsSchema,
    criteria: z
      .record(z.string(), z.string())
      .refine(
        (criteria) => Object.keys(criteria).length >= 1 && Object.keys(criteria).length <= MAX_CHOICE_OPTIONS,
        `criteria must have 1 to ${MAX_CHOICE_OPTIONS} options`,
      ),
  })
  .strict();

const noulQuestion = z
  .object({
    type: z.literal("noul"),
    instructions: instructionsSchema,
  })
  .strict();

const scoreQuestion = z
  .object({
    type: z.literal("score"),
    instructions: instructionsSchema,
    criteria: z.array(z.string()).min(2).max(MAX_SCORE_LEVELS),
  })
  .strict();

const questionSchema = z.discriminatedUnion("type", [choiceQuestion, noulQuestion, scoreQuestion]);

const questionsSchema = z
  .record(questionNameSchema, questionSchema)
  .refine(
    (questions) => Object.keys(questions).length >= 1 && Object.keys(questions).length <= MAX_QUESTIONS,
    `questions must have 1 to ${MAX_QUESTIONS} entries`,
  );

export const decideParamsSchema = z
  .object({
    state: stateSchema,
    questions: questionsSchema,
  })
  .strict();

export type DecideParams = z.infer<typeof decideParamsSchema>;

const NO_KEY_TEXT =
  "TypeSafe unavailable (no key: set apiKey in the typesafe plugin settings) — continue with your own judgment.";
const TIMEOUT_TEXT = "TypeSafe unavailable (timeout) — continue with your own judgment.";
const BAD_RESPONSE_TEXT = "TypeSafe unavailable (bad response) — continue with your own judgment.";

function describeDecideError(error: DecideError): string {
  switch (error.kind) {
    case "no-key":
      return NO_KEY_TEXT;
    case "timeout":
      return TIMEOUT_TEXT;
    case "http":
      return `TypeSafe unavailable (HTTP ${error.status}) — continue with your own judgment.`;
    case "bad-response":
      return BAD_RESPONSE_TEXT;
  }
}

function shortSummary(error: z.ZodError): string {
  const text = z.prettifyError(error);
  return text.length > MAX_ERROR_SUMMARY_CHARS ? `${text.slice(0, MAX_ERROR_SUMMARY_CHARS - 3)}...` : text;
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** A choice answer outside the requested options (or a missing answer) is a bad response. */
function answersAreConsistent(requested: QuestionMap, answers: Record<string, Answer>): boolean {
  for (const [name, question] of Object.entries(requested)) {
    const answer = answers[name];
    if (answer === undefined) return false;
    if (question.type === "choice") {
      if (answer.type !== "choice") return false;
      if (!(answer.choice in question.criteria)) return false;
    }
  }
  return true;
}

export interface DecideToolOptions {
  getApiKey: () => string | null;
  getModel: () => string;
  log: (line: string) => void;
}

export function registerDecideTool(bb: BbPluginApi, opts: DecideToolOptions): void {
  bb.agents.registerTool({
    name: "typesafe_decide",
    description:
      "Ask TypeSafe's Jev model for a typed judgment: Choice between options, Noul yes/no probability, or Score on a scale. Advisory.",
    instructions: TOOL_INSTRUCTIONS,
    parameters: decideParamsSchema,
    async execute(params) {
      const parsed = decideParamsSchema.safeParse(params);
      if (!parsed.success) {
        return toolError(`TypeSafe invalid arguments (${shortSummary(parsed.error)}) — fix the call.`);
      }
      const outcome = await decide(
        {
          state: parsed.data.state,
          questions: parsed.data.questions,
          model: opts.getModel(),
          apiKey: opts.getApiKey(),
          timeoutMs: TOOL_TIMEOUT_MS,
        },
        { log: opts.log },
      );
      if (outcome.kind !== "ok") return toolError(describeDecideError(outcome));
      if (!answersAreConsistent(parsed.data.questions, outcome.value.answers)) {
        return toolError(BAD_RESPONSE_TEXT);
      }
      const { model, answers, usage } = outcome.value;
      return { content: [{ type: "text", text: JSON.stringify({ model, answers, usage }) }] };
    },
  });
}
