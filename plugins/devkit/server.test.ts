import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import plugin, { buildDocsToolSpec, buildToolSpecs, loadIndex, resolveDataRoot } from "./server.js";
import type { SkillIndex } from "./src/rank.mjs";
import { ESSENTIALS, TIER_A } from "./src/select-skills.mjs";

function fakeFetch(body: string, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, text: async () => body })) as unknown as typeof fetch;
}

let dataRoot: string;

const INDEX: SkillIndex = {
  generatedAt: "t",
  categories: ["go", "database"],
  skills: [
    { slug: "go-testing", description: "Go tests", category: "go", keywords: ["golang"], tokens: ["go", "test", "golang"] },
    { slug: "database-redis", description: "Redis", category: "database", keywords: ["redis"], tokens: ["redis"] },
  ],
};

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), "devkit-server-"));
  await mkdir(path.join(dataRoot, "skills", "go-testing"), { recursive: true });
  await writeFile(path.join(dataRoot, "skills", "go-testing", "SKILL.md"), "# Go testing\nbody\n");
  await writeFile(path.join(dataRoot, "index.json"), JSON.stringify(INDEX));
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("resolveDataRoot", () => {
  it("resolves content/ from a source dir", () => {
    expect(resolveDataRoot("/plugins/devkit")).toBe(path.join("/plugins/devkit", "content"));
  });
  it("resolves content/ from a dist bundle dir (sibling of dist)", () => {
    expect(resolveDataRoot("/plugins/devkit/dist")).toBe(path.join("/plugins/devkit", "content"));
  });
});

describe("loadIndex", () => {
  it("reads a valid index.json", async () => {
    const warn = vi.fn();
    const idx = await loadIndex(dataRoot, warn);
    expect(idx.skills).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });
  it("drops malformed entries and coerces non-conforming metadata", async () => {
    const dir = path.join(dataRoot, "malformed");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "index.json"),
      JSON.stringify({
        generatedAt: 42,
        categories: "go",
        skills: [{ slug: "ok", description: "fine" }, { slug: 1, description: "x" }, null, "str", { slug: "no-desc" }],
      }),
    );
    const warn = vi.fn();
    const idx = await loadIndex(dir, warn);
    expect(idx).toEqual({ generatedAt: "", categories: [], skills: [{ slug: "ok", description: "fine" }] });
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps only string categories", async () => {
    const dir = path.join(dataRoot, "mixed-categories");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.json"), JSON.stringify({ categories: ["go", 7, null, "rust"], skills: [] }));
    const idx = await loadIndex(dir, vi.fn());
    expect(idx.categories).toEqual(["go", "rust"]);
  });

  it("warns and falls back when index.json has no skills array", async () => {
    const dir = path.join(dataRoot, "no-skills");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.json"), JSON.stringify({ generatedAt: "t", skills: {} }));
    const warn = vi.fn();
    const idx = await loadIndex(dir, warn);
    expect(idx.skills).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("index.json has no skills array"));
  });

  it("warns and falls back on invalid JSON", async () => {
    const dir = path.join(dataRoot, "bad-json");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.json"), "{ not json");
    const warn = vi.fn();
    const idx = await loadIndex(dir, warn);
    expect(idx).toEqual({ generatedAt: "", categories: [], skills: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not load skill index"));
  });

  it("falls back to an empty index and warns when the file is missing", async () => {
    const warn = vi.fn();
    const idx = await loadIndex(path.join(dataRoot, "does-not-exist"), warn);
    expect(idx.skills).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("formats a non-Error index load failure with String(error)", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return { ...actual, readFile: async () => { throw "boom"; } };
    });
    try {
      const { loadIndex: freshLoadIndex } = await import("./server.js");
      const warn = vi.fn();
      const idx = await freshLoadIndex(dataRoot, warn);
      expect(idx).toEqual({ generatedAt: "", categories: [], skills: [] });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("could not load skill index");
      expect(warn.mock.calls[0]![0]).toContain("boom");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

describe("buildToolSpecs", () => {
  it("registers exactly the two tools", () => {
    const specs = buildToolSpecs(INDEX, dataRoot);
    expect(specs.map((s) => s.name)).toEqual(["devkit_find_skills", "devkit_load_skill"]);
  });

  it("advertises the index categories in the find_skills description", () => {
    const [find] = buildToolSpecs(INDEX, dataRoot);
    expect(find!.description).toContain("Domains covered: go, database.");
    const [bare] = buildToolSpecs({ generatedAt: "", categories: [], skills: [] }, dataRoot);
    expect(bare!.description).not.toContain("Domains covered");
  });

  it("find_skills returns ranked hits", async () => {
    const find = buildToolSpecs(INDEX, dataRoot)[0]!;
    const out = await find.execute({ topic: "golang", limit: 5 });
    expect(out).toBe('devkit skills for "golang" (load with devkit_load_skill):\n- go-testing: Go tests');
  });

  it("find_skills defaults the limit when omitted", async () => {
    const find = buildToolSpecs(INDEX, dataRoot)[0]!;
    expect(find.parameters.parse({ topic: "golang" })).toEqual({ topic: "golang", limit: 8 });
    const out = await find.execute({ topic: "golang" });
    expect(String(out)).toContain("- go-testing: Go tests");
  });

  it("find_skills gives a guidance message on zero match", async () => {
    const find = buildToolSpecs(INDEX, dataRoot)[0]!;
    const out = await find.execute({ topic: "zzz-nope", limit: 5 });
    expect(out).toBe('No devkit skill matched "zzz-nope". Try a broader term. Domains: go, database.');
  });

  it("find_skills flags an empty index in the zero-match message", async () => {
    const find = buildToolSpecs({ generatedAt: "", categories: [], skills: [] }, dataRoot)[0]!;
    const out = await find.execute({ topic: "anything", limit: 5 });
    expect(String(out)).toContain("empty");
    expect(String(out)).not.toContain("Domains:");
  });

  it("load_skill returns a body on success", async () => {
    const load = buildToolSpecs(INDEX, dataRoot)[1]!;
    const out = await load.execute({ slug: "go-testing" });
    expect(String(out)).toContain("Go testing");
  });

  it("load_skill returns an error shape for a bad slug", async () => {
    const load = buildToolSpecs(INDEX, dataRoot)[1]!;
    const out = await load.execute({ slug: "../../etc/passwd" });
    expect(typeof out).toBe("object");
    expect((out as { isError?: boolean }).isError).toBe(true);
  });

  it("load_skill surfaces not_found as an error tool result", async () => {
    const load = buildToolSpecs(INDEX, dataRoot)[1]!;
    const out = (await load.execute({ slug: "missing-skill" })) as { content: { text: string }[]; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("Skill 'missing-skill' not found");
  });

  it("load_skill schema requires slug or reference", () => {
    const load = buildToolSpecs(INDEX, dataRoot)[1]!;
    const bad = load.parameters.safeParse({});
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe("Provide slug or reference.");
    expect(load.parameters.safeParse({ reference: "owasp" }).success).toBe(true);
  });
});

describe("buildDocsToolSpec", () => {
  it("schema requires query or libraryId", () => {
    const spec = buildDocsToolSpec();
    const bad = spec.parameters.safeParse({});
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe("Provide query or libraryId.");
    expect(spec.parameters.safeParse({ libraryId: "/vercel/next.js" }).success).toBe(true);
  });

  it("forwards the abort signal to fetch", async () => {
    const fetchImpl = fakeFetch("DOC");
    const controller = new AbortController();
    const spec = buildDocsToolSpec({ fetchImpl });
    expect(await spec.execute({ query: "react hooks" }, { signal: controller.signal })).toBe("DOC");
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBe(controller.signal);
  });

  it("falls back to the global fetch when no fetchImpl is injected", async () => {
    const globalFetch = fakeFetch("GLOBAL DOC");
    vi.stubGlobal("fetch", globalFetch);
    try {
      const out = await buildDocsToolSpec().execute({ query: "zod refine" });
      expect(out).toBe("GLOBAL DOC");
      expect((globalFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
        "https://context7.com/api/v1/search?query=zod%20refine",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts the Context7 id format its own description advertises (leading slash)", async () => {
    const fetchImpl = fakeFetch("NEXT DOCS");
    const spec = buildDocsToolSpec({ fetchImpl });
    expect(spec.description).toContain('"/vercel/next.js"');
    expect(await spec.execute({ libraryId: "/vercel/next.js" })).toBe("NEXT DOCS");
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      "https://context7.com/api/v1/vercel/next.js?type=txt",
    );
  });

  it("maps a successful fetch to body text", async () => {
    const spec = buildDocsToolSpec({ fetchImpl: fakeFetch("DOC BODY") });
    expect(spec.name).toBe("devkit_docs");
    const out = await spec.execute({ query: "react hooks" });
    expect(out).toBe("DOC BODY");
  });

  it("maps a failed fetch to an error tool result", async () => {
    const spec = buildDocsToolSpec({ fetchImpl: fakeFetch("", false, 500) });
    const out = await spec.execute({ query: "react hooks" });
    expect((out as { isError?: boolean }).isError).toBe(true);
  });
});

type CliRegistration = {
  name: string;
  commands: { name: string }[];
  run: (argv: string[], ctx?: { threadId?: string | null }) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
};

function fakeBb(send: (req: unknown) => Promise<unknown> = async () => undefined) {
  const tools: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }[] = [];
  const instructions: (() => string)[] = [];
  const configurers: ((ctx: unknown) => { tools: string[]; skills: string[] })[] = [];
  const clis: CliRegistration[] = [];
  const warn = vi.fn();
  const sendSpy = vi.fn(send);
  const bb = {
    log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    agents: {
      registerTool: (spec: (typeof tools)[number]) => tools.push(spec),
      contributeInstructions: (fn: () => string) => instructions.push(fn),
      configure: (fn: (typeof configurers)[number]) => configurers.push(fn),
    },
    cli: { register: (reg: CliRegistration) => clis.push(reg) },
    sdk: { threads: { send: sendSpy } },
  } as unknown as BbPluginApi;
  return { bb, tools, instructions, configurers, clis, warn, send: sendSpy };
}

describe("plugin entrypoint", () => {
  it("registers all three tools from the committed content index without warnings", async () => {
    const f = fakeBb();
    await plugin(f.bb);
    expect(f.tools.map((t) => t.name)).toEqual(["devkit_find_skills", "devkit_load_skill", "devkit_docs"]);
    expect(f.warn).not.toHaveBeenCalled();
    const out = await f.tools[0]!.execute({ topic: "go testing", limit: 3 });
    expect(String(out)).toContain("- go-testing:");
  });

  it("warns and registers an empty-surface index when the committed index fails to load", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return { ...actual, readFile: async () => { throw new Error("no index on disk"); } };
    });
    try {
      const { default: freshPlugin } = await import("./server.js");
      const f = fakeBb();
      await freshPlugin(f.bb);
      expect(f.warn).toHaveBeenCalledOnce();
      expect(f.warn.mock.calls[0]![0]).toContain("could not load skill index");
      expect(f.warn.mock.calls[0]![0]).toContain("no index on disk");
      expect(f.tools.map((t) => t.name)).toEqual(["devkit_find_skills", "devkit_load_skill", "devkit_docs"]);
      const out = await f.tools[0]!.execute({ topic: "anything", limit: 3 });
      expect(String(out)).toContain("empty");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("contributes the always-on instruction", async () => {
    const f = fakeBb();
    await plugin(f.bb);
    expect(f.instructions).toHaveLength(1);
    expect(f.instructions[0]!()).toContain("devkit_find_skills");
  });

  it("configure exposes every registered tool and selects skills by thread origin", async () => {
    const f = fakeBb();
    await plugin(f.bb);
    expect(f.configurers).toHaveLength(1);
    const configure = f.configurers[0]!;
    const toolNames = f.tools.map((t) => t.name);
    expect(configure({ origin: { kind: "user" } })).toEqual({ tools: toolNames, skills: [...TIER_A, ...ESSENTIALS] });
    expect(configure({ origin: { kind: "fork" } })).toEqual({ tools: toolNames, skills: [...TIER_A] });
  });

  it("registers the devkit CLI with its subcommands", async () => {
    const f = fakeBb();
    await plugin(f.bb);
    expect(f.clis).toHaveLength(1);
    expect(f.clis[0]!.name).toBe("devkit");
    expect(f.clis[0]!.commands.map((c) => c.name)).toEqual(["commands", "run", "review", "skills"]);
  });

  it("CLI prints instructions without a thread and never calls threads.send", async () => {
    const f = fakeBb();
    await plugin(f.bb);
    const run = f.clis[0]!.run;
    for (const ctx of [undefined, {}, { threadId: null }]) {
      const r = await run(["review", "code"], ctx);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("review-code");
    }
    expect(f.send).not.toHaveBeenCalled();
  });

  it("CLI injects the instruction as a turn in the calling thread", async () => {
    const f = fakeBb();
    await plugin(f.bb);
    const r = await f.clis[0]!.run(["review", "code"], { threadId: "thr_1" });
    expect(r).toEqual({ exitCode: 0, stdout: expect.stringContaining("Review requested") });
    expect(f.send).toHaveBeenCalledOnce();
    const req = f.send.mock.calls[0]![0] as { threadId: string; mode: string; input: { type: string; text: string; mentions: unknown[] }[] };
    expect(req.threadId).toBe("thr_1");
    expect(req.mode).toBe("auto");
    expect(req.input).toHaveLength(1);
    expect(req.input[0]!.type).toBe("text");
    expect(req.input[0]!.text).toContain("devkit_load_skill({ slug: \"review-code\" })");
    expect(req.input[0]!.mentions).toEqual([]);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it.each([
    [new Error("thread busy"), "thread busy"],
    ["plain string failure", "plain string failure"],
  ])("CLI warns and falls back to printing when threads.send rejects (%s)", async (failure, expected) => {
    const f = fakeBb(async () => {
      throw failure;
    });
    await plugin(f.bb);
    const r = await f.clis[0]!.run(["review", "code"], { threadId: "thr_1" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("review-code");
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.warn).toHaveBeenCalledWith(`devkit: could not inject the turn, printing instructions instead: ${expected}`);
  });
});
