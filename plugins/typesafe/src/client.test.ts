import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decide, redact, type QuestionMap } from "./client.js";
import { decideParamsSchema } from "./tool.js";

// Fixture secrets are assembled from fragments so no literal token appears in source.
const GHP = `ghp_${"a".repeat(36)}`;
const GITHUB_PAT = `github_pat_${"b".repeat(30)}`;
const SK_TOKEN = `sk-${"c".repeat(20)}`;
const XOXB = `xoxb-${"1".repeat(24)}`;
const AWS_KEY = `AKIA${"D".repeat(16)}`;
const BEARER_LINE = `Bearer ${"e".repeat(24)}`;
const USERINFO_URL = "https://user:pass@example.com/repo.git";
const ENV_LINE = ["API", "KEY=abc", "123"].join("");
const TEST_KEY = ["test", "key", "abc123"].join("-");

const SAVED_KEY = process.env.TYPESAFE_API_KEY;

const fetchMock = vi.fn();

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function minimalQuestions() {
  return { q: { type: "noul" as const, instructions: "Yes or no?" } };
}

function minimalAnswers() {
  return { q: { type: "noul", noul: 0.4 } };
}

function decideWith(state: string, questions: QuestionMap = minimalQuestions()) {
  return decide({
    state,
    questions,
    model: "jev-1.13.0",
    apiKey: TEST_KEY,
    timeoutMs: 1500,
  });
}

beforeAll(() => {
  delete process.env.TYPESAFE_API_KEY;
});

afterAll(() => {
  if (SAVED_KEY === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = SAVED_KEY;
});

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("decide", () => {
  it("parses all three answer types and strips unknown fields", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-1.13.0",
        request_id: "req-1",
        answers: {
          pick: {
            type: "choice",
            choice: "b",
            confidence: 0.9,
            probabilities: { a: 0.1, b: 0.9 },
            raw_thinking: "should not survive",
          },
          yes: { type: "noul", noul: 0.7, debug: [1, 2, 3] },
          size: {
            type: "score",
            score: 1.43,
            confidence: 0.8,
            probabilities: { 0: 0.1, 1: 0.5, 2: 0.4 },
            legend: { 0: "low", 1: "mid", 2: "high" },
            trace: "gone",
          },
        },
        usage: { input_tokens: 332, output_tokens: 18 },
      }),
    );
    const outcome = await decideWith("state text", {
      pick: { type: "choice", instructions: "Pick one", criteria: { a: "A", b: "B" } },
      yes: { type: "noul", instructions: "Yes or no?" },
      size: { type: "score", instructions: "Size it", criteria: ["low", "mid", "high"] },
    });
    expect(outcome).toEqual({
      kind: "ok",
      value: {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "b",
            confidence: 0.9,
            probabilities: { a: 0.1, b: 0.9 },
          },
          yes: { type: "noul", noul: 0.7 },
          size: {
            type: "score",
            score: 1.43,
            confidence: 0.8,
            probabilities: { 0: 0.1, 1: 0.5, 2: 0.4 },
            legend: { 0: "low", 1: "mid", 2: "high" },
          },
        },
        usage: { input_tokens: 332, output_tokens: 18 },
      },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      model: "jev-1.13.0",
      state: "state text",
      questions: {
        pick: { type: "choice", instructions: "Pick one", criteria: { a: "A", b: "B" } },
        yes: { type: "noul", instructions: "Yes or no?" },
        size: { type: "score", instructions: "Size it", criteria: ["low", "mid", "high"] },
      },
    });
  });

  it("clamps confidence and probabilities to [0,1] but not score", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "a",
            confidence: 1.2,
            probabilities: { a: -0.1, b: 1.1 },
          },
          size: {
            type: "score",
            score: 7.5,
            confidence: 0.5,
            probabilities: { 0: 0.5, 1: 0.5 },
            legend: { 0: "low", 1: "high" },
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const outcome = await decideWith("s", {
      pick: { type: "choice", instructions: "Pick", criteria: { a: "A", b: "B" } },
      size: { type: "score", instructions: "Size", criteria: ["low", "high"] },
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const pick = outcome.value.answers.pick;
    const size = outcome.value.answers.size;
    if (pick.type !== "choice" || size.type !== "score") throw new Error("wrong answer types");
    expect(pick.confidence).toBe(1);
    expect(pick.probabilities).toEqual({ a: 0, b: 1 });
    expect(size.score).toBe(7.5);
  });

  it.each([422, 500])("maps HTTP %i to an http error with the status", async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status } as unknown as Response);
    const outcome = await decideWith("s");
    expect(outcome).toEqual({ kind: "http", status });
  });

  it("maps a malformed JSON body to a bad-response error", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    } as unknown as Response);
    expect(await decideWith("s")).toEqual({ kind: "bad-response" });
  });

  it("maps a body failing the schema to a bad-response error", async () => {
    fetchMock.mockResolvedValue(okResponse({ unexpected: true }));
    expect(await decideWith("s")).toEqual({ kind: "bad-response" });
  });

  it("maps a non-finite answer number to a bad-response error", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-1.13.0",
        answers: { q: { type: "noul", noul: Number.NaN } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    expect(await decideWith("s")).toEqual({ kind: "bad-response" });
  });

  it("times out when fetch never resolves", async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const pending = decideWith("s");
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toEqual({ kind: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns no-key without calling fetch when no apiKey is given", async () => {
    const outcome = await decide({
      state: "s",
      questions: minimalQuestions(),
      model: "jev-1.13.0",
      apiKey: null,
      timeoutMs: 1500,
    });
    expect(outcome).toEqual({ kind: "no-key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts every secret kind from the sent state but keeps the URL host", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-1.13.0",
        answers: minimalAnswers(),
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const state = [
      `github ${GHP}`,
      `fine-grained ${GITHUB_PAT}`,
      `openai ${SK_TOKEN}`,
      `slack ${XOXB}`,
      `aws ${AWS_KEY}`,
      `curl -H 'Authorization: ${BEARER_LINE}'`,
      `clone from ${USERINFO_URL}`,
      ENV_LINE,
    ].join("\n");
    await decideWith(state);
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).not.toContain(GHP);
    expect(body).not.toContain(GITHUB_PAT);
    expect(body).not.toContain(SK_TOKEN);
    expect(body).not.toContain(XOXB);
    expect(body).not.toContain(AWS_KEY);
    expect(body).not.toContain("e".repeat(24));
    expect(body).not.toContain("user:pass");
    expect(body).toContain("https://REDACTED@example.com/repo.git");
    expect(body).not.toContain("KEY=abc");
    expect(body).toContain("KEY=REDACTED");
  });

  it("redacts PEM key blocks", () => {
    const marker = ["-----BEGIN PRIVATE ", "KEY-----"].join("");
    const pem = `${marker}\nMIIEvQIBADANBg\nmore lines\n-----END PRIVATE KEY-----\nafter`;
    expect(redact(`head ${pem}`)).toBe("head REDACTED\nafter");
  });

  it("sends a ~15999-char adversarial state once, redacted, without stalling", async () => {
    vi.useRealTimers();
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-1.13.0",
        answers: minimalAnswers(),
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const fragment = `-----BEGIN PRIVATE ${"KEY"}-----\nabc\n`;
    const run = `sk-${"Aa".repeat(16)} `;
    let state = "";
    while (state.length < 15999) state += fragment + run;
    state = state.slice(0, 15999);
    const params = { state, questions: minimalQuestions() };
    expect(() => decideParamsSchema.parse(params)).not.toThrow();
    const startedAt = Date.now();
    const outcome = await decideWith(state);
    const elapsed = Date.now() - startedAt;
    expect(outcome.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(1000);
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain("REDACTED");
    expect(body).not.toContain(run.trim());
  });

  it("logs only status and duration, never body content or the key", async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-1.13.0",
        answers: minimalAnswers(),
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const state = "sensitive-state-content";
    await decide(
      { state, questions: minimalQuestions(), model: "jev-1.13.0", apiKey: TEST_KEY, timeoutMs: 1500 },
      { log },
    );
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const second = decide(
      { state, questions: minimalQuestions(), model: "jev-1.13.0", apiKey: TEST_KEY, timeoutMs: 1500 },
      { log },
    );
    await vi.advanceTimersByTimeAsync(1500);
    await second;
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/^typesafe status=\d+ duration=\d+ms$/);
    }
    expect(lines.join("\n")).not.toContain(state);
    expect(lines.join("\n")).not.toContain(TEST_KEY);
  });
});
