import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
  type PluginCliRegistration,
} from "@get-bb/plugin-sdk";
import plugin from "./server.js";

let cli: PluginCliRegistration;
let listSkills: (
  input: null,
  context: { experimental_signal: AbortSignal },
) => Promise<{ ok: boolean; skills?: unknown; error?: string }>;
const rpcContext = () => ({
  experimental_signal: new AbortController().signal,
});
const skill = (
  uri = "skill://margrave/source/rev/nested/example/SKILL.md",
  description = "description",
) => ({ uri, frontmatter: { name: "Example", description } });
let pages: unknown[];
let requests: Array<{
  method: string;
  params: unknown;
  redirect: RequestRedirect | undefined;
  url: string;
}>;

beforeEach(() => {
  pages = [{ skills: [skill()] }];
  requests = [];
  plugin({
    cli: {
      register(value: PluginCliRegistration) {
        cli = value;
      },
    },
    rpc: {
      register(
        _contract: unknown,
        handlers: { listSkills: typeof listSkills },
      ) {
        listSkills = handlers.listSkills;
      },
    },
  } as unknown as BbPluginApi);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") return new Response(null, { status: 405 });
      expect(init?.method).toBe("POST");
      const message = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
        params: unknown;
      };
      requests.push({
        method: message.method,
        params: message.params,
        redirect: init?.redirect,
        url: String(url),
      });
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "margrave", version: "1" },
            }
          : pages.shift();
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("hosted Margrave CLI and RPC", () => {
  it("does not fetch for help or invalid arguments", async () => {
    expect((await cli.run(["list", "--help"], {})).exitCode).toBe(0);
    expect((await cli.run(["list", "bad"], {})).exitCode).not.toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("negotiates the observed 2025-11-25 handshake, 202 notification and SSE pages without a session ID", async () => {
    pages = [
      {
        skills: Array.from({ length: 50 }, (_, i) =>
          skill(`skill://margrave/source/rev/s${i}/SKILL.md`),
        ),
        nextCursor: "opaque",
      },
      { skills: [skill("skill://margrave/other/rev/nested/x/SKILL.md")] },
    ];
    const result = await cli.run(["list", "--json"], {});
    const catalog = JSON.parse(result.stdout!);
    expect(catalog.sources).toEqual([
      { id: "source", skillCount: 50 },
      { id: "other", skillCount: 1 },
    ]);
    expect(catalog.skills[50]).toEqual({
      id: "other/nested/x",
      source: "other",
      name: "Example",
      description: "description",
    });
    expect(
      requests
        .filter((r) => r.method !== "notifications/cancelled")
        .map((r) => r.method),
    ).toEqual([
      "initialize",
      "notifications/initialized",
      "skills/list",
      "skills/list",
    ]);
    expect(
      requests.filter((r) => r.method === "skills/list").map((r) => r.params),
    ).toEqual([{}, { cursor: "opaque" }]);
    expect(
      requests.every(
        (r) =>
          r.redirect === "error" &&
          r.url === "https://margrave.valksor.tools/mcp",
      ),
    ).toBe(true);
    pages = [
      { skills: [skill()], nextCursor: "next" },
      { skills: [skill("skill://margrave/other/rev/x/SKILL.md")] },
    ];
    expect(await listSkills(null, rpcContext())).toEqual({
      ok: true,
      skills: [
        {
          id: "source/nested/example",
          name: "Example",
          description: "description",
        },
        { id: "other/x", name: "Example", description: "description" },
      ],
    });
  });
  it("reads both catalogs without a standalone GET", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method === "GET") throw new Error("GET unavailable");
      return original(url, init);
    });

    expect((await cli.run(["list", "--json"], {})).exitCode).toBe(0);
    pages = [{ skills: [skill()] }];
    expect(await listSkills(null, rpcContext())).toMatchObject({ ok: true });
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method !== "GET"))
      .toBe(true);
  });
  it("handles empty catalogs and escapes terminal controls in both CLI modes", async () => {
    pages = [{ skills: [] }];
    expect((await cli.run(["list"], {})).stdout).toBe(
      "No skills in the Margrave catalog.\n",
    );
    pages = [{ skills: [skill(undefined, "line\n\u009b\u202eend")] }];
    expect((await cli.run(["list"], {})).stdout).toBe(
      "source  skills=1\n  source/nested/example: line\\u000a\\u009b\\u202eend\n",
    );
    pages = [{ skills: [skill(undefined, "line\n\u009b\u202eend")] }];
    const output = (await cli.run(["list", "--json"], {})).stdout!;
    expect(output).toContain("\\u009b\\u202e");
    expect(JSON.parse(output).skills[0].description).toBe(
      "line\n\u009b\u202eend",
    );
  });
  it.each([
    { skills: [{}] },
    { skills: "bad" },
    { skills: [], nextCursor: "" },
    { skills: [skill("https://example.com/a")] },
    { skills: [skill("skill://margrave/source/rev/a%2Fb/SKILL.md")] },
    { skills: [skill("skill://margrave/source/rev/../SKILL.md")] },
    { skills: [skill("skill://margrave/source/rev/%zz/SKILL.md")] },
    ...["%D8%9C", "%E2%80%8E", "%E2%80%8F", "%E2%80%AA", "%E2%80%AE", "%E2%81%A6", "%E2%81%A9"].map(
      (control) => ({ skills: [skill(`skill://margrave/source/rev/a${control}b/SKILL.md`)] }),
    ),
    { skills: [skill("skill://margrave/source/rev//SKILL.md")] },
  ])("rejects invalid page or URI %#", async (page) => {
    pages = [page];
    expect(await listSkills(null, rpcContext())).toEqual({
      ok: false,
      error: "invalid",
    });
    pages = [page];
    const result = await cli.run(["list", "--json"], {});
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(
      "Margrave returned an invalid skill catalog.",
    );
  });
  it("rejects repeated cursors without returning a partial catalog", async () => {
    pages = [
      { skills: [skill()], nextCursor: "same" },
      { skills: [], nextCursor: "same" },
    ];
    expect(await listSkills(null, rpcContext())).toEqual({
      ok: false,
      error: "invalid",
    });
  });
  it("returns fixed local errors for transport failures and redirects", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("remote secret"));
    const result = await cli.run(["list"], {});
    expect(result.stderr).toContain(
      "Could not read the hosted Margrave skill catalog.",
    );
    expect(result.stderr).not.toContain("remote secret");
    expect(await listSkills(null, rpcContext())).toEqual({
      ok: false,
      error: "failed",
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example/" },
      }),
    );
    expect(await listSkills(null, rpcContext())).toEqual({
      ok: false,
      error: "failed",
    });
  });
  it("aborts an active SSE stream on caller cancellation", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let cancelled = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method !== "POST") return original(url, init);
      const message = JSON.parse(String(init?.body));
      if (message.method !== "skills/list") return original(url, init);
      return new Response(
        new ReadableStream({
          start() {
            started();
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const controller = new AbortController();
    const result = listSkills(null, { experimental_signal: controller.signal });
    await ready;
    controller.abort();
    expect(await result).toEqual({ ok: false, error: "failed" });
    expect(cancelled).toBe(true);
  });
  it("rejects cumulative bytes in an unfinished later SSE event", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let listCount = 0;
    let cancelled = false;
    let bytesSent = 0;
    pages = [{ skills: [skill()], nextCursor: "next" }];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method !== "POST") return original(url, init);
      const message = JSON.parse(String(init?.body));
      if (message.method === "skills/list" && ++listCount === 2) {
        const chunk = new TextEncoder().encode("x".repeat(1024));
        const bodyLimit = PLUGIN_CLI_OUTPUT_MAX_BYTES - 100;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (bytesSent === 0) {
                bytesSent += 6;
                controller.enqueue(new TextEncoder().encode("data: "));
              } else if (bytesSent < bodyLimit) {
                const next = chunk.subarray(
                  0,
                  Math.min(chunk.length, bodyLimit - bytesSent),
                );
                bytesSent += next.length;
                controller.enqueue(next);
              }
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return original(url, init);
    });
    expect(await listSkills(null, rpcContext())).toEqual({
      ok: false,
      error: "failed",
    });
    expect(cancelled).toBe(true);
  });
  it("limits serialized output even when the response fits", async () => {
    pages = [
      {
        skills: [
          skill(
            undefined,
            "\u009b".repeat(Math.ceil(PLUGIN_CLI_OUTPUT_MAX_BYTES / 5)),
          ),
        ],
      },
    ];
    const result = await cli.run(["list", "--json"], {});
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(
      "Could not read the hosted Margrave skill catalog.",
    );
  });
  it("applies one deadline across pages and cancels the active stream", async () => {
    vi.useFakeTimers();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let count = 0;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled = false;
    pages = [{ skills: [skill()], nextCursor: "next" }];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method !== "POST") return original(url, init);
      const message = JSON.parse(String(init?.body));
      if (message.method === "skills/list") {
        if (++count === 1) await vi.advanceTimersByTimeAsync(15_000);
        else
          return new Response(
            new ReadableStream({
              start() {
                started();
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
      }
      return original(url, init);
    });
    const result = listSkills(null, rpcContext());
    await ready;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual({ ok: false, error: "failed" });
    expect(cancelled).toBe(true);
  });
  it.each(["cli", "rpc"])("fails promptly on invalid POST SSE JSON: %s", async (entry) => {
    vi.useFakeTimers();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let cancelled = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method !== "POST") return original(url, init);
      const message = JSON.parse(String(init.body));
      if (message.method !== "skills/list") return original(url, init);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: message\ndata: {bad}\n\n"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    let settled = false;
    const result = Promise.resolve(
      entry === "cli" ? cli.run(["list"], {}) : listSkills(null, rpcContext()),
    ).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(100);
    const settledPromptly = settled;
    await vi.advanceTimersByTimeAsync(30_000);
    const value = await result;
    expect(settledPromptly).toBe(true);
    expect(cancelled).toBe(true);
    if (entry === "cli") {
      expect(value).toMatchObject({
        stderr: expect.stringContaining("Could not read the hosted Margrave skill catalog."),
      });
    } else {
      expect(value).toEqual({ ok: false, error: "failed" });
    }
  });
  it("cancels the POST reader when the content type is unsupported", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let cancelled = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method !== "POST") return original(url, init);
      const message = JSON.parse(String(init.body));
      if (message.method !== "skills/list") return original(url, init);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("Service unavailable"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    });

    expect(await listSkills(null, rpcContext())).toEqual({
      ok: false,
      error: "failed",
    });
    expect(cancelled).toBe(true);
  });
  it("cancels each open POST result before requesting the next page", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    const cancelled: string[] = [];
    let page = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method !== "POST") return original(url, init);
      const message = JSON.parse(String(init.body));
      if (message.method !== "initialize" && message.method !== "skills/list") return original(url, init);
      if (message.method === "skills/list") {
        expect(cancelled).toContain(page === 0 ? "initialize" : "page1");
        page++;
      }
      const label = message.method === "initialize" ? "initialize" : `page${page}`;
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "margrave", version: "1" } }
        : page === 1 ? { skills: [skill()], nextCursor: "next" } : { skills: [skill()] };
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`));
        },
        cancel() { cancelled.push(label); },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    expect(await listSkills(null, rpcContext())).toMatchObject({ ok: true });
    expect(cancelled).toEqual(["initialize", "page1", "page2"]);
  });
});
