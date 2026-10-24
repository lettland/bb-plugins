import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import type { FakeAgentToolRecord, FakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { parseSkipProjects, skipProjectsSettingSchema } from "./server.js";
import { TOOL_INSTRUCTIONS, decideParamsSchema } from "./src/tool.js";
import { TriageStore, TRIAGE_STORE_CAP, buildTriageEntry } from "./src/triage.js";

// Assembled from fragments so no secret-shaped literal appears in source.
const TEST_KEY = ["test", "key"].join("-");

const SAVED_KEY = process.env.TYPESAFE_API_KEY;

const fetchMock = vi.fn();

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function triageResponse() {
  return {
    model: "jev-1.14.0",
    answers: {
      kind: {
        type: "choice",
        choice: "heavy_change",
        confidence: 0.83,
        probabilities: { question: 0.05, small_change: 0.2, heavy_change: 0.75 },
      },
      needs_plan: { type: "noul", noul: 0.9 },
    },
    usage: { input_tokens: 332, output_tokens: 18 },
  };
}

function createHost(settings: Record<string, string | boolean> = {}): FakePluginHost {
  return createFakePluginHost({ pluginId: "typesafe", settings });
}

function decideTool(host: FakePluginHost): FakeAgentToolRecord {
  const tool = host.harness.registrations.agentTools.find((entry) => entry.name === "typesafe_decide");
  if (tool === undefined) throw new Error("typesafe_decide is not registered");
  return tool;
}

function hookOf(host: FakePluginHost) {
  const hook = host.harness.registrations.hooks["message.dispatch"];
  if (hook === null) throw new Error("message.dispatch hook is not registered");
  return hook;
}

const TOOL_CTX = { threadId: "thread-1", projectId: "project-1", signal: new AbortController().signal };

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

describe("typesafe_decide tool", () => {
  it("ships instructions under the 4096-character limit", () => {
    expect(TOOL_INSTRUCTIONS.length).toBeLessThan(4096);
  });

  it("rejects over-limit arguments at parse time", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    const record = decideTool(host);
    const noul = { type: "noul", instructions: "Why?" };
    const cases = [
      { state: "x".repeat(16001), questions: { q: noul } },
      { state: "ok", questions: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i}`, noul])) },
      { state: "ok", questions: { q: { type: "noul", instructions: "x".repeat(2001) } } },
      {
        state: "ok",
        questions: {
          q: {
            type: "choice",
            instructions: "Pick",
            criteria: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`opt${i}`, "d"])),
          },
        },
      },
      { state: "ok", questions: { q: { type: "score", instructions: "Size", criteria: ["only"] } } },
      {
        state: "ok",
        questions: {
          q: { type: "score", instructions: "Size", criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) },
        },
      },
    ];
    for (const input of cases) {
      expect(record.parse(input).ok).toBe(false);
      expect(decideParamsSchema.safeParse(input).success).toBe(false);
    }
    host.harness.dispose();
  });

  it("accepts the boundary values the limits allow", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    const record = decideTool(host);
    expect(
      record.parse({
        state: "x".repeat(16000),
        questions: { q: { type: "noul", instructions: "x".repeat(2000) } },
      }).ok,
    ).toBe(true);
    host.harness.dispose();
  });

  it("returns the exact no-key error text and never fetches", async () => {
    const host = createHost();
    await plugin(host.bb);
    const record = decideTool(host);
    const result = await record.execute(
      { state: "s", questions: { q: { type: "noul", instructions: "Why?" } } },
      TOOL_CTX,
    );
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "TypeSafe unavailable (no key: set apiKey in the typesafe plugin settings) — continue with your own judgment.",
        },
      ],
      isError: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.harness.dispose();
  });

  it("maps an out-of-range choice answer to the bad-response error", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-1.14.0",
        answers: {
          pick: { type: "choice", choice: "not-offered", confidence: 0.9, probabilities: { a: 1 } },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const record = decideTool(host);
    const result = await record.execute(
      { state: "s", questions: { pick: { type: "choice", instructions: "Pick", criteria: { a: "A" } } } },
      TOOL_CTX,
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "TypeSafe unavailable (bad response) — continue with your own judgment." }],
      isError: true,
    });
    await host.harness.dispose();
  });

  it("maps an http error status to its error text", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue({ ok: false, status: 422 } as unknown as Response);
    const record = decideTool(host);
    const result = await record.execute(
      { state: "s", questions: { q: { type: "noul", instructions: "Why?" } } },
      TOOL_CTX,
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "TypeSafe unavailable (HTTP 422) — continue with your own judgment." }],
      isError: true,
    });
    await host.harness.dispose();
  });

  it("maps a timeout to the exact timeout error text", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const record = decideTool(host);
    const pending = record.execute(
      { state: "s", questions: { q: { type: "noul", instructions: "Why?" } } },
      TOOL_CTX,
    );
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toEqual({
      content: [{ type: "text", text: "TypeSafe unavailable (timeout) — continue with your own judgment." }],
      isError: true,
    });
    await host.harness.dispose();
  });

  it("maps an API body failing the schema to the exact bad-response error text", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue(okResponse({ unexpected: true }));
    const record = decideTool(host);
    const result = await record.execute(
      { state: "s", questions: { q: { type: "noul", instructions: "Why?" } } },
      TOOL_CTX,
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "TypeSafe unavailable (bad response) — continue with your own judgment." }],
      isError: true,
    });
    await host.harness.dispose();
  });

  it("returns the untruncated invalid-arguments error for a small schema failure", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    const record = decideTool(host);
    const input = { state: "s", questions: {} };
    const parsed = decideParamsSchema.safeParse(input);
    if (parsed.success) throw new Error("expected the empty questions object to fail validation");
    const result = await record.execute(input, TOOL_CTX);
    expect(result).toEqual({
      content: [
        { type: "text", text: `TypeSafe invalid arguments (${z.prettifyError(parsed.error)}) — fix the call.` },
      ],
      isError: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.harness.dispose();
  });

  it("truncates an invalid-arguments error longer than 300 characters", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    const record = decideTool(host);
    const questions = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`q${i}`, { type: "bogus", instructions: "x" }]),
    );
    const input = { state: "s", questions };
    const parsed = decideParamsSchema.safeParse(input);
    if (parsed.success) throw new Error("expected the bogus question types to fail validation");
    const full = z.prettifyError(parsed.error);
    expect(full.length).toBeGreaterThan(300);
    const result = await record.execute(input, TOOL_CTX);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `TypeSafe invalid arguments (${full.slice(0, 297)}...) — fix the call.`,
        },
      ],
      isError: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.harness.dispose();
  });

  it("serializes an object state before sending it", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-1.14.0",
        answers: { q: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const record = decideTool(host);
    const result = (await record.execute(
      {
        state: { context: "Which database?", rows: 3 },
        questions: { q: { type: "noul", instructions: "Why?" } },
      },
      TOOL_CTX,
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.state).toBe('{"context":"Which database?","rows":3}');
    await host.harness.dispose();
  });

  it("maps a missing answer for a requested question to the bad-response error", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-1.14.0",
        answers: {
          pick: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 1 } },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const record = decideTool(host);
    const result = await record.execute(
      {
        state: "s",
        questions: {
          pick: { type: "choice", instructions: "Pick", criteria: { a: "A" } },
          why: { type: "noul", instructions: "Why?" },
        },
      },
      TOOL_CTX,
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "TypeSafe unavailable (bad response) — continue with your own judgment." }],
      isError: true,
    });
    await host.harness.dispose();
  });

  it("maps a wrong-type answer to the bad-response error", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-1.14.0",
        answers: { pick: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const record = decideTool(host);
    const result = await record.execute(
      {
        state: "s",
        questions: { pick: { type: "choice", instructions: "Pick", criteria: { a: "A" } } },
      },
      TOOL_CTX,
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "TypeSafe unavailable (bad response) — continue with your own judgment." }],
      isError: true,
    });
    await host.harness.dispose();
  });

  it("returns compact JSON with answers keyed by question name", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-1.14.0",
        answers: {
          pick: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } },
          why: { type: "noul", noul: 0.3 },
          size: {
            type: "score",
            score: 2.5,
            confidence: 0.7,
            probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
            legend: { 0: "low", 1: "mid", 2: "high" },
          },
        },
        usage: { input_tokens: 12, output_tokens: 34 },
      }),
    );
    const record = decideTool(host);
    const result = (await record.execute(
      {
        state: "Choose an approach for the export feature.",
        questions: {
          pick: { type: "choice", instructions: "Pick", criteria: { a: "A", b: "B" } },
          why: { type: "noul", instructions: "Why?" },
          size: { type: "score", instructions: "Size", criteria: ["low", "mid", "high"] },
        },
      },
      TOOL_CTX,
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(JSON.parse(text)).toEqual({
      model: "jev-1.14.0",
      answers: {
        pick: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } },
        why: { type: "noul", noul: 0.3 },
        size: {
          type: "score",
          score: 2.5,
          confidence: 0.7,
          probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
          legend: { 0: "low", 1: "mid", 2: "high" },
        },
      },
      usage: { input_tokens: 12, output_tokens: 34 },
    });
    expect(text).not.toContain(", ");
    await host.harness.dispose();
  });
});

describe("agent configuration", () => {
  it("selects typesafe_decide and no skills by default", async () => {
    const host = createHost();
    await plugin(host.bb);
    const resolved = await host.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    expect(resolved.tools.map((tool) => tool.name)).toEqual(["typesafe_decide"]);
    expect(resolved.skills).toEqual([]);
    await host.harness.dispose();
  });

  it("selects nothing for a fork origin (side chat)", async () => {
    const host = createHost();
    await plugin(host.bb);
    const resolved = await host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ origin: { kind: "fork", pluginId: "side-chat" } }),
    );
    expect(resolved.tools).toEqual([]);
    await host.harness.dispose();
  });

  it("selects nothing for a skipped project, and still the tool elsewhere", async () => {
    const host = createHost({ skipProjects: '["skipped-*"]' });
    await plugin(host.bb);
    const skipped = await host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ project: { name: "skipped-project" } }),
    );
    expect(skipped.tools).toEqual([]);
    const kept = await host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ project: { name: "kept-project" } }),
    );
    expect(kept.tools.map((tool) => tool.name)).toEqual(["typesafe_decide"]);
    await host.harness.dispose();
  });

  it("applies a settings change to the model and skip globs without a reload", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-2.0.0",
        answers: { q: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    await host.harness.setSettings({ model: "jev-2.0.0", skipProjects: '["now-*"]' });
    const record = decideTool(host);
    await record.execute(
      { state: "s", questions: { q: { type: "noul", instructions: "Why?" } } },
      TOOL_CTX,
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.model).toBe("jev-2.0.0");
    const resolved = await host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ project: { name: "now-skipped" } }),
    );
    expect(resolved.tools).toEqual([]);
    await host.harness.dispose();
  });
});

describe("message.dispatch triage hook", () => {
  it.each(["agent", "system", "mixed"] as const)(
    "proceeds without fetching for initiator %s",
    async (initiator) => {
      const host = createHost({ apiKey: TEST_KEY });
      await plugin(host.bb);
      const decision = await hookOf(host)(makeMessageDispatchHookContext({ initiator }));
      expect(decision).toEqual({ action: "proceed" });
      expect(fetchMock).not.toHaveBeenCalled();
      await host.harness.dispose();
    },
  );

  it("proceeds without fetching for a join-turn attempt", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    const decision = await hookOf(host)(makeMessageDispatchHookContext({ attempt: "join-turn" }));
    expect(decision).toEqual({ action: "proceed" });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.harness.dispose();
  });

  it("proceeds without fetching for a child thread", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    const decision = await hookOf(host)(
      makeMessageDispatchHookContext({ parentThreadId: "thr_parent" }),
    );
    expect(decision).toEqual({ action: "proceed" });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.harness.dispose();
  });

  it("proceeds without fetching when the thread already has an entry", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue(okResponse(triageResponse()));
    const first = await hookOf(host)(
      makeMessageDispatchHookContext({ input: { text: "Refactor the export pipeline." } }),
    );
    expect(first).toEqual({ action: "proceed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const second = await hookOf(host)(
      makeMessageDispatchHookContext({ input: { text: "A follow-up message." } }),
    );
    expect(second).toEqual({ action: "proceed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await host.harness.dispose();
  });

  it("proceeds without fetching for a re-attempt carrying queued messages", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    const decision = await hookOf(host)(
      makeMessageDispatchHookContext({ queuedMessages: [{}] }),
    );
    expect(decision).toEqual({ action: "proceed" });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.harness.dispose();
  });

  it("proceeds without fetching for a non-pending thread with an empty store", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    const decision = await hookOf(host)(
      makeMessageDispatchHookContext({ thread: { status: "active" } }),
    );
    expect(decision).toEqual({ action: "proceed" });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.harness.dispose();
  });

  it("proceeds without fetching when triage is off", async () => {
    const host = createHost({ apiKey: TEST_KEY, triage: false });
    await plugin(host.bb);
    const decision = await hookOf(host)(makeMessageDispatchHookContext());
    expect(decision).toEqual({ action: "proceed" });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.harness.dispose();
  });

  it("proceeds without fetching for a skipped project", async () => {
    const host = createHost({ apiKey: TEST_KEY, skipProjects: '["skipped-*"]' });
    await plugin(host.bb);
    const decision = await hookOf(host)(
      makeMessageDispatchHookContext({ project: { name: "skipped-project" } }),
    );
    expect(decision).toEqual({ action: "proceed" });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.harness.dispose();
  });

  it("stores an entry on success and serves the exact line for that thread only", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue(okResponse(triageResponse()));
    const decision = await hookOf(host)(
      makeMessageDispatchHookContext({ input: { text: "Refactor the export pipeline." } }),
    );
    expect(decision).toEqual({ action: "proceed" });
    const line = host.harness.registrations.instructionProvider?.({
      threadId: "thread-1",
      projectId: "project-1",
    });
    expect(line).toBe(
      "TypeSafe triage of this thread's opening request (advisory): heavy_change (p=0.75, conf 0.83); plan first p=0.90. Later decisions: call typesafe_decide.",
    );
    expect(
      host.harness.registrations.instructionProvider?.({ threadId: "thread-unknown", projectId: "p" }),
    ).toBeNull();
    await host.harness.dispose();
  });

  it("proceeds and stores nothing when the client times out", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const decision = hookOf(host)(makeMessageDispatchHookContext());
    await vi.advanceTimersByTimeAsync(1500);
    expect(await decision).toEqual({ action: "proceed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      host.harness.registrations.instructionProvider?.({ threadId: "thread-1", projectId: "p" }),
    ).toBeNull();
    await host.harness.dispose();
  });

  it("proceeds and stores nothing on a client error", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    const decision = await hookOf(host)(makeMessageDispatchHookContext());
    expect(decision).toEqual({ action: "proceed" });
    expect(
      host.harness.registrations.instructionProvider?.({ threadId: "thread-1", projectId: "p" }),
    ).toBeNull();
    await host.harness.dispose();
  });

  it("proceeds, never fetches, and stores nothing when no key is available", async () => {
    const host = createHost();
    await plugin(host.bb);
    const decision = await hookOf(host)(makeMessageDispatchHookContext());
    expect(decision).toEqual({ action: "proceed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      host.harness.registrations.instructionProvider?.({ threadId: "thread-1", projectId: "p" }),
    ).toBeNull();
    await host.harness.dispose();
  });

  it("does not leak request content into the log", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue(okResponse(triageResponse()));
    await hookOf(host)(
      makeMessageDispatchHookContext({ input: { text: "Refactor the export pipeline with secret ghp stuff" } }),
    );
    const logged = host.harness.logEntries.map((entry) => entry.message).join("\n");
    expect(logged).toMatch(/^typesafe status=\d+ duration=\d+ms$/m);
    expect(logged).not.toContain("Refactor the export pipeline");
    expect(logged).not.toContain(TEST_KEY);
    await host.harness.dispose();
  });

  it("proceeds with a warning and stores nothing when the dispatch input is malformed", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    const decision = await hookOf(host)(
      makeMessageDispatchHookContext({ input: { text: undefined as unknown as string } }),
    );
    expect(decision).toEqual({ action: "proceed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.harness.logEntries.some((entry) => entry.message.startsWith("triage skipped:"))).toBe(true);
    expect(
      host.harness.registrations.instructionProvider?.({ threadId: "thread-1", projectId: "p" }),
    ).toBeNull();
    await host.harness.dispose();
  });

  it("proceeds with a warning when triage throws a non-Error", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    // A text object whose replace throws stands in for any non-Error failure.
    const hostile = { replace: () => { throw "boom"; } };
    const decision = await hookOf(host)(
      makeMessageDispatchHookContext({ input: { text: hostile as unknown as string } }),
    );
    expect(decision).toEqual({ action: "proceed" });
    expect(host.harness.logEntries.some((entry) => entry.message.includes("triage skipped: boom"))).toBe(
      true,
    );
    await host.harness.dispose();
  });

  it("proceeds and stores nothing when the answers cannot build an entry", async () => {
    const host = createHost({ apiKey: TEST_KEY });
    await plugin(host.bb);
    fetchMock.mockResolvedValue(
      okResponse({
        model: "jev-1.14.0",
        answers: {},
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    );
    const decision = await hookOf(host)(makeMessageDispatchHookContext());
    expect(decision).toEqual({ action: "proceed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      host.harness.registrations.instructionProvider?.({ threadId: "thread-1", projectId: "p" }),
    ).toBeNull();
    await host.harness.dispose();
  });
});

describe("triage store", () => {
  it("evicts the oldest entry past the cap", () => {
    const store = new TriageStore();
    for (let i = 0; i <= TRIAGE_STORE_CAP; i += 1) {
      store.set(`thread-${i}`, { kind: "question", p: 0.5, conf: 0.5, plan: 0.5 });
    }
    expect(store.has("thread-0")).toBe(false);
    expect(store.line("thread-0")).toBeNull();
    expect(store.has(`thread-${TRIAGE_STORE_CAP}`)).toBe(true);
  });

  it("rejects an unvalidated kind", () => {
    expect(
      buildTriageEntry({
        kind: {
          type: "choice",
          choice: "invented_kind",
          confidence: 0.9,
          probabilities: { invented_kind: 0.9 },
        },
        needs_plan: { type: "noul", noul: 0.5 },
      }),
    ).toBeNull();
  });

  it("rejects answers without a kind answer", () => {
    expect(buildTriageEntry({ needs_plan: { type: "noul", noul: 0.5 } })).toBeNull();
  });

  it("rejects a kind answer without a probability for its choice", () => {
    expect(
      buildTriageEntry({
        kind: {
          type: "choice",
          choice: "question",
          confidence: 0.9,
          probabilities: { small_change: 0.9 },
        },
        needs_plan: { type: "noul", noul: 0.5 },
      }),
    ).toBeNull();
  });

  it("rejects answers without a needs_plan answer", () => {
    expect(
      buildTriageEntry({
        kind: {
          type: "choice",
          choice: "question",
          confidence: 0.9,
          probabilities: { question: 0.9 },
        },
      }),
    ).toBeNull();
  });
});

describe("startup", () => {
  it("reports needs-configuration when no key exists anywhere", async () => {
    const host = createHost();
    await plugin(host.bb);
    expect(host.harness.needsConfigurationMessages).toContain(
      "no TypeSafe key: triage and tool inactive",
    );
    await host.harness.dispose();
  });

  it("reports nothing when an environment key is set", async () => {
    process.env.TYPESAFE_API_KEY = ["env", "test", "key"].join("-");
    try {
      const host = createHost();
      await plugin(host.bb);
      expect(host.harness.needsConfigurationMessages).not.toContain(
        "no TypeSafe key: triage and tool inactive",
      );
      await host.harness.dispose();
    } finally {
      delete process.env.TYPESAFE_API_KEY;
    }
  });

  it("warns and disables triage selection only for an unparseable skipProjects value", async () => {
    const host = createHost({ skipProjects: "not json" });
    await plugin(host.bb);
    const resolved = await host.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    expect(resolved.tools.map((tool) => tool.name)).toEqual(["typesafe_decide"]);
    expect(host.harness.logEntries.some((entry) => entry.message.includes("skipProjects setting ignored"))).toBe(
      true,
    );
    expect(parseSkipProjects('["a-*", "b"]')).toEqual(["a-*", "b"]);
    await host.harness.dispose();
  });

  it("reports the schema problem when a skipProjects entry is not a non-empty string", () => {
    expect(() => parseSkipProjects('[""]')).toThrowError(
      "Too small: expected string to have >=1 characters",
    );
  });

  it("wraps a non-Error JSON parse failure in parseSkipProjects", () => {
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw "boom";
    });
    try {
      expect(() => parseSkipProjects("junk")).toThrowError("not valid JSON: boom");
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("accepts a valid setting value and reports the JSON problem for an invalid one", () => {
    expect(skipProjectsSettingSchema.safeParse('["a-*", "b"]').success).toBe(true);
    const bad = skipProjectsSettingSchema.safeParse("not json");
    expect(bad.success).toBe(false);
    if (bad.success) throw new Error("expected the setting value to fail validation");
    expect(bad.error.issues[0]?.message).toContain("not valid JSON");
  });

  it("reports a non-Error JSON failure through the setting schema", () => {
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw "boom";
    });
    try {
      const bad = skipProjectsSettingSchema.safeParse("junk");
      expect(bad.success).toBe(false);
      if (bad.success) throw new Error("expected the setting value to fail validation");
      expect(bad.error.issues[0]?.message).toBe("not valid JSON: boom");
    } finally {
      parseSpy.mockRestore();
    }
  });
});
