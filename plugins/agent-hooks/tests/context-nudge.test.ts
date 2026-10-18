// context-nudge.sh: one additionalContext per 200k band, driven by a synthetic
// transcript. Multi-step cases share ONE project dir, because runHook deletes a dir
// it owns after each call and the per-session state file would be gone.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, makeProjectDir, runHook, runWithoutProjectDir } from "./run-hook.mjs";

const SID = "nudge-session_1";
const STATE_REL = path.join(".claude", "logs", `.context-nudge-${SID}`);

let scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch) cleanup(dir);
  scratch = [];
});

function project(): string {
  const dir = makeProjectDir();
  scratch.push(dir);
  return dir;
}

type Usage = { input_tokens: unknown; cache_read_input_tokens: unknown; cache_creation_input_tokens: unknown };

/** An assistant transcript line whose three usage fields sum to `total`. */
function entry(total: number, model = "claude-test-1"): string {
  const usage: Usage = { input_tokens: 2, cache_read_input_tokens: total - 2 - 1000, cache_creation_input_tokens: 1000 };
  return JSON.stringify({ type: "assistant", message: { model, usage } });
}

const SYNTHETIC_ZERO = JSON.stringify({
  type: "assistant",
  message: { model: "<synthetic>", usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

function transcript(dir: string, lines: string[]): string {
  const file = path.join(dir, "transcript.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

async function nudge(dir: string, lines: string[] | null, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const file = lines === null ? path.join(dir, "no-such-transcript.jsonl") : transcript(dir, lines);
  const r = await runHook(
    "context-nudge.sh",
    {},
    { projectDir: dir, toolName: "Read", env, envelope: { hook_event_name: "PostToolUse", session_id: SID, transcript_path: file, ...extra } },
  );
  const context: string | null = r.stdout.trim() === "" ? null : JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  return { ...r, context };
}

describe("context-nudge.sh", () => {
  it("fires once for a 250k context and not again on the same band", async () => {
    const dir = project();
    const first = await nudge(dir, [entry(250_000)]);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(first.context).toContain("~250k tokens");
    expect(first.context).toContain("report back to your parent");
    expect(readFileSync(path.join(dir, STATE_REL), "utf8").trim()).toBe("200000");
    expect((await nudge(dir, [entry(260_000)])).context).toBeNull();
  });

  it("stays silent below the first band", async () => {
    const dir = project();
    expect((await nudge(dir, [entry(199_000)])).context).toBeNull();
    expect(existsSync(path.join(dir, STATE_REL))).toBe(false);
  });

  it("fires for 450k", async () => {
    const dir = project();
    const r = await nudge(dir, [entry(450_000)]);
    expect(r.context).toContain("~450k tokens");
    expect(readFileSync(path.join(dir, STATE_REL), "utf8").trim()).toBe("400000");
  });

  it("re-fires on the climb after a compaction (450k, 50k, 250k)", async () => {
    const dir = project();
    expect((await nudge(dir, [entry(450_000)])).context).not.toBeNull();
    expect((await nudge(dir, [entry(50_000)])).context).toBeNull();
    expect(readFileSync(path.join(dir, STATE_REL), "utf8").trim()).toBe("0");
    expect((await nudge(dir, [entry(250_000)])).context).toContain("~250k tokens");
  });

  it("fires once for a jump over several bands (150k to 650k)", async () => {
    const dir = project();
    expect((await nudge(dir, [entry(150_000)])).context).toBeNull();
    expect((await nudge(dir, [entry(650_000)])).context).toContain("~650k tokens");
    expect(readFileSync(path.join(dir, STATE_REL), "utf8").trim()).toBe("600000");
    expect((await nudge(dir, [entry(660_000)])).context).toBeNull();
  });

  it("caps the band at 800k", async () => {
    const dir = project();
    expect((await nudge(dir, [entry(924_000)])).context).toContain("~924k tokens");
    expect(readFileSync(path.join(dir, STATE_REL), "utf8").trim()).toBe("800000");
    expect((await nudge(dir, [entry(990_000)])).context).toBeNull();
  });

  it("does not re-arm on a <synthetic> zero entry", async () => {
    const dir = project();
    expect((await nudge(dir, [entry(450_000)])).context).not.toBeNull();
    // The synthetic entry is last, but the real 450k reading before it is the one used.
    expect((await nudge(dir, [entry(450_000), SYNTHETIC_ZERO])).context).toBeNull();
    expect(readFileSync(path.join(dir, STATE_REL), "utf8").trim()).toBe("400000");
    // A transcript holding only the synthetic entry has no reading at all.
    expect((await nudge(dir, [SYNTHETIC_ZERO])).context).toBeNull();
    expect(readFileSync(path.join(dir, STATE_REL), "utf8").trim()).toBe("400000");
  });

  it("is a no-op when agent_id is present (a subagent tool call)", async () => {
    const dir = project();
    const r = await nudge(dir, [entry(450_000)], { agent_id: "agent-abc123" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(path.join(dir, STATE_REL))).toBe(false);
  });

  it("treats an empty agent_id as the main thread", async () => {
    const dir = project();
    expect((await nudge(dir, [entry(450_000)], { agent_id: "" })).context).not.toBeNull();
  });

  it("is a no-op when the transcript is missing", async () => {
    const dir = project();
    const r = await nudge(dir, null);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(path.join(dir, STATE_REL))).toBe(false);
  });

  it("still reads the previous entry when the last line is malformed", async () => {
    const dir = project();
    const partial = '{"type":"assistant","message":{"model":"claude-test-1","usage":{"input_tok';
    expect((await nudge(dir, [entry(250_000), partial])).context).toContain("~250k tokens");
  });

  it("is a no-op under AGENT_HOOKS_HOST=codex", async () => {
    const dir = project();
    const r = await nudge(dir, [entry(450_000)], {}, { AGENT_HOOKS_HOST: "codex" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(path.join(dir, STATE_REL))).toBe(false);
  });

  it("is a no-op without a usable session id", async () => {
    const dir = project();
    const r = await nudge(dir, [entry(450_000)], { session_id: "../.." });
    // "../.." reduces to "" after the [A-Za-z0-9_-] filter, so there is nowhere to keep state.
    expect(r.stdout).toBe("");
  });

  it("never lets an untrusted state file or usage value reach arithmetic", async () => {
    const dir = project();
    const marker = path.join(dir, "pwned");
    writeFileSync(path.join(dir, STATE_REL), `a[$(touch ${marker})]\n`);
    const bad = JSON.stringify({
      type: "assistant",
      message: { model: "claude-test-1", usage: { input_tokens: "x[$(touch " + marker + ")]", cache_read_input_tokens: 450_000, cache_creation_input_tokens: null } },
    });
    const r = await nudge(dir, [bad]);
    expect(r.exitCode).toBe(0);
    expect(r.context).toContain("~450k tokens");
    expect(existsSync(marker)).toBe(false);
  });

  it("is a no-op without CLAUDE_PROJECT_DIR", async () => {
    const r = await runWithoutProjectDir("context-nudge.sh", {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});
