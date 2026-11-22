import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { catalogErrors, rpcContract } from "./contract.js";

const pageSchema = z.object({
  skills: z.array(
    z.object({
      uri: z.string(),
      frontmatter: z.object({ name: z.string(), description: z.string() }),
    }),
  ),
  nextCursor: z.string().min(1).optional(),
});

type Skill = { id: string; name: string; description: string; source: string };

function invalid(): never {
  throw new PluginCliError(catalogErrors.invalid, { code: "margrave_invalid" });
}

function skillId(uri: string): { id: string; source: string } {
  const match =
    /^skill:\/\/margrave\/([^/?#]+)\/([^/?#]+)\/([^/?#]+(?:\/[^/?#]+)*)\/SKILL\.md$/.exec(
      uri,
    );
  if (!match) return invalid();
  let parts: string[];
  try {
    parts = [match[1]!, match[2]!, ...match[3]!.split("/")].map(
      decodeURIComponent,
    );
  } catch {
    return invalid();
  }
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[/\\?#\x00-\x1f\x7f]/.test(part),
    )
  )
    return invalid();
  const source = parts[0]!;
  return { source, id: [source, ...parts.slice(2)].join("/") };
}

function unicodeEscape(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function jsonOutput(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    unicodeEscape,
  );
}

function bounded(output: string): string {
  if (Buffer.byteLength(output) > PLUGIN_CLI_OUTPUT_MAX_BYTES) {
    throw new PluginCliError(catalogErrors.failed, { code: "margrave_failed" });
  }
  return output;
}

function boundedFetch(signal: AbortSignal, controller: AbortController) {
  let bytes = 0;
  return async (url: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(url, { ...init, redirect: "error", signal });
    if (!response.body) return response;
    if (signal.aborted) {
      await response.body.cancel();
      throw new Error(catalogErrors.failed);
    }
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const result = await reader.read();
          if (signal.aborted) throw new Error(catalogErrors.failed);
          if (result.done) {
            signal.removeEventListener("abort", cancel);
            stream.close();
            return;
          }
          bytes += result.value.byteLength;
          if (bytes > PLUGIN_CLI_OUTPUT_MAX_BYTES) {
            controller.abort();
            throw new Error(catalogErrors.failed);
          }
          stream.enqueue(result.value);
        } catch (error) {
          signal.removeEventListener("abort", cancel);
          stream.error(error);
        }
      },
      cancel() {
        signal.removeEventListener("abort", cancel);
        return reader.cancel();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function appendSkills(
  entries: z.infer<typeof pageSchema>["skills"],
  skills: Skill[],
  counts: Map<string, number>,
) {
  for (const entry of entries) {
    const { id, source } = skillId(entry.uri);
    skills.push({
      id,
      name: entry.frontmatter.name,
      description: entry.frontmatter.description,
      source,
    });
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
}

async function readCatalog(callerSignal?: AbortSignal) {
  const controller = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), 30_000);
  const client = new Client({ name: "bb-margrave", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://margrave.valksor.tools/mcp"),
    { fetch: boundedFetch(signal, controller) },
  );
  try {
    await client.connect(transport, { signal });
    const skills: Skill[] = [];
    const counts = new Map<string, number>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const value = await client.request(
        {
          method: "skills/list",
          params: cursor === undefined ? {} : { cursor },
        },
        z.unknown(),
        { signal },
      );
      const page = pageSchema.safeParse(value);
      if (!page.success) invalid();
      appendSkills(page.data.skills, skills, counts);
      cursor = page.data.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) invalid();
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    const catalog = {
      sources: Array.from(counts, ([id, skillCount]) => ({ id, skillCount })),
      skills,
    };
    return catalog;
  } catch (error) {
    if (error instanceof PluginCliError && error.code === "margrave_invalid")
      throw error;
    throw new PluginCliError(catalogErrors.failed, { code: "margrave_failed" });
  } finally {
    clearTimeout(timer);
    await client.close();
    controller.abort();
  }
}

function escapeText(value: string): string {
  return value.replace(
    /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    unicodeEscape,
  );
}

function textOutput(catalog: Awaited<ReturnType<typeof readCatalog>>): string {
  if (catalog.sources.length === 0) {
    return "No skills in the Margrave catalog.\n";
  }
  const lines = new Map<string, string[]>();
  for (const skill of catalog.skills) {
    const line = `  ${escapeText(skill.id)}: ${escapeText(skill.description)}\n`;
    const group = lines.get(skill.source) ?? [];
    group.push(line);
    lines.set(skill.source, group);
  }
  return catalog.sources
    .map((source) => {
      const header = `${escapeText(source.id)}  skills=${source.skillCount}\n`;
      return header + (lines.get(source.id) ?? []).join("");
    })
    .join("");
}

export default function plugin(bb: BbPluginApi) {
  bb.cli.register(
    defineCli({
      name: "margrave",
      summary: "List skills in the hosted Margrave catalog",
      commands: {
        list: cliCommand({
          summary: "List skills in the hosted Margrave catalog",
          options: { json: { type: "boolean", description: "Output JSON" } },
          async run(input, context) {
            const catalog = await readCatalog(context.signal);
            const output =
              input.options.json === true
                ? `${jsonOutput(catalog)}\n`
                : textOutput(catalog);
            return { exitCode: 0, stdout: bounded(output) };
          },
        }),
      },
    }),
  );
  bb.rpc.register(rpcContract, {
    async listSkills(_input, context) {
      try {
        const { skills } = await readCatalog(context.experimental_signal);
        const result = {
          ok: true as const,
          skills: skills.map(({ id, name, description }) => ({
            id,
            name,
            description,
          })),
        };
        bounded(JSON.stringify(result));
        return result;
      } catch (error) {
        return {
          ok: false as const,
          error:
            error instanceof PluginCliError && error.code === "margrave_invalid"
              ? ("invalid" as const)
              : ("failed" as const),
        };
      }
    },
  });
}
