import type { Question } from "./client.js";

/** The exact trivial-change definition, shared verbatim with auto-review. */
export const TRIVIAL_CHANGE =
  "Trivial: one file, a few lines, the exact change already settled, and no design choice the user has not seen. Anything else that changes code or config is non-trivial.";

/** The fixed sizing question; triage sends it for every top-level thread's user request. */
export const CHANGE_SIZE_QUESTION: Question = {
  type: "choice",
  instructions: `Classify the user's request to this thread. ${TRIVIAL_CHANGE}`,
  criteria: {
    question: "A question, discussion, or lookup — no code or config change is requested",
    trivial: "The request is trivial by the definition above",
    non_trivial: "The request asks for a change that is not trivial",
  },
};
