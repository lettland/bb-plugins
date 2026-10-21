import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  plan as planJs,
  planClaude as planClaudeJs,
  planCodex as planCodexJs,
  planUninstall as planUninstallJs,
  readConfig,
  writeConfigAtomic,
  backupConfig,
  countOurs,
  expectedCount,
} from "./wire.mjs";

// wire.mjs is untyped JS; give its plan output a shape so strict TS accepts the
// callbacks below.
type Hook = { type?: string; command: string };
type Group = { matcher?: string; hooks: Hook[] };
type Config = { hooks: Record<string, Group[]>; [key: string]: unknown };
const plan = planJs as (kind: string, data: unknown, opts?: { uninstall?: boolean }) => Config;
const planClaude = planClaudeJs as (data: unknown) => Config;
const planCodex = planCodexJs as (data: unknown) => Config;
const planUninstall = planUninstallJs as (data: unknown) => Config;

const tmp = () => mkdtempSync(path.join(tmpdir(), "wire-test-"));

describe("claude merge", () => {
  it("creates a missing event key rather than assuming it exists", () => {
    // ~/.claude-work/settings.json has hooks.Stop with an empty array and NO
    // PreToolUse key at all. A merge that assumed the key would throw.
    const out = planClaude({ hooks: { Stop: [{ matcher: "", hooks: [] }] } });
    expect(out.hooks.PreToolUse).toBeDefined();
    expect(out.hooks.PreToolUse.length).toBeGreaterThan(0);
  });

  it("appends without clobbering an unrelated neighbour", () => {
    const cc = { hooks: [{ type: "command", command: "/Users/x/.config/iterm2/cc-status" }] };
    const out = planClaude({ hooks: { PreToolUse: [cc], SessionStart: [cc] } });
    const commands = out.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain("/Users/x/.config/iterm2/cc-status");
    expect(commands.some((c) => c.includes("guard-bash.sh"))).toBe(true);
  });

  it("preserves unrelated top-level settings", () => {
    const out = planClaude({ model: "opus[1m]", theme: "dark", hooks: {} });
    expect(out.model).toBe("opus[1m]");
    expect(out.theme).toBe("dark");
  });

  it("is idempotent: installing twice yields the same entry count", () => {
    const once = planClaude({ hooks: {} });
    const twice = planClaude(once);
    expect(countOurs(twice)).toBe(countOurs(once));
    expect(countOurs(once)).toBe(expectedCount());
  });

  it("attaches the right matcher to each gate", () => {
    const out = planClaude({ hooks: {} });
    const pre = out.hooks.PreToolUse;
    const byScript = (name: string) => pre.find((g) => g.hooks.some((h) => h.command.includes(name)))!;
    expect(byScript("guard-bash.sh").matcher).toBe("Bash");
    expect(byScript("secret-scan.sh").matcher).toBe("Write|Edit|MultiEdit");
    expect(byScript("review-plan-before-exit.sh").matcher).toBe("ExitPlanMode");
  });

  it("wires verify-before-stop to both Stop and SubagentStop", () => {
    const out = planClaude({ hooks: {} });
    for (const ev of ["Stop", "SubagentStop"]) {
      expect(out.hooks[ev].some((g) => g.hooks.some((h) => h.command.includes("verify-before-stop.sh")))).toBe(true);
    }
  });
});

describe("codex merge", () => {
  it("routes every hook through the shim", () => {
    const out = planCodex({ hooks: {} });
    const all = Object.values(out.hooks).flatMap((g) => g.flatMap((x) => x.hooks.map((h) => h.command)));
    expect(all.length).toBe(expectedCount());
    for (const cmd of all) expect(cmd).toContain("codex-shim.sh");
  });

  it("uses the same CamelCase events as Claude, not the snake_case state keys", () => {
    // Regression: the first version wired pre_tool_use/session_start/stop, taken
    // from config.toml's [hooks.state."<plugin>:pre_tool_use:0:0"] keys. Those are
    // a state-tracking namespace. hooks.json uses PreToolUse/Stop/SessionStart,
    // so the snake_case entries parsed fine and would never have fired.
    const out = planCodex({ hooks: {} });
    expect(Object.keys(out.hooks).sort()).toEqual(
      ["PostToolUse", "PreToolUse", "SessionStart", "Stop", "SubagentStop"].sort(),
    );
    for (const snake of ["pre_tool_use", "session_start", "stop", "subagent_stop"]) {
      expect(out.hooks[snake]).toBeUndefined();
    }
  });

  it("preserves gitkraken and the other codex neighbours", () => {
    // Shapes copied from the real ~/.codex/hooks.json, including gitkraken's
    // quoted absolute path -- the reason a naive `gk ai hook run` substring check
    // reports it missing when it is present.
    const gk = '"/Users/x/Library/Application Support/GitKrakenCLI/gk" ai hook run --host codex';
    const neighbours = {
      hooks: {
        PreToolUse: [
          { matcher: "Edit|Write|MultiEdit|Bash", hooks: [{ type: "command", command: "'/Users/x/.codex/hooks/deny-bgisolation-none.sh'" }] },
          { matcher: "", hooks: [{ type: "command", command: gk }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "npx --yes @thestackai/zclean" }] }],
      },
    };
    const out = planCodex(neighbours);
    const pre = out.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    expect(pre.some((c) => c.includes("deny-bgisolation-none.sh"))).toBe(true);
    expect(pre.some((c) => c === gk)).toBe(true);
    expect(out.hooks.Stop.some((g) => g.hooks.some((h) => h.command.includes("zclean")))).toBe(true);
  });
});

describe("uninstall", () => {
  it("removes only our entries", () => {
    const cc = { hooks: [{ type: "command", command: "/Users/x/.config/iterm2/cc-status" }] };
    const installed = planClaude({ hooks: { PreToolUse: [cc], Stop: [cc] } });
    const clean = planUninstall(installed);
    expect(countOurs(clean)).toBe(0);
    const remaining = Object.values(clean.hooks).flatMap((g) => g.flatMap((x) => x.hooks.map((h) => h.command)));
    expect(remaining).toEqual(remaining.filter((c) => c.includes("cc-status")));
    expect(remaining.length).toBe(2);
  });

  it("leaves a config that never had our entries untouched", () => {
    const original = { hooks: { Stop: [{ matcher: "", hooks: [] }] }, theme: "dark" };
    expect(planUninstall(original)).toEqual(original);
  });
});

describe("file safety", () => {
  it("refuses malformed JSON instead of merging into it", () => {
    const dir = tmp();
    const f = path.join(dir, "settings.json");
    writeFileSync(f, "{ this is not json ");
    expect(() => readConfig(f)).toThrow(/not valid JSON/);
    // and the file is untouched
    expect(readFileSync(f, "utf8")).toBe("{ this is not json ");
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats a missing file as empty rather than failing", () => {
    const dir = tmp();
    const r = readConfig(path.join(dir, "nope.json"));
    expect(r.existed).toBe(false);
    expect(r.data).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes atomically and leaves no temp file behind", () => {
    const dir = tmp();
    const f = path.join(dir, "settings.json");
    writeConfigAtomic(f, plan("claude", { hooks: {} }));
    expect(countOurs(JSON.parse(readFileSync(f, "utf8")))).toBe(expectedCount());
    expect(existsSync(path.join(dir, ".settings.json.agent-hooks.tmp"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("backs up an existing config before the first write", () => {
    const dir = tmp();
    const f = path.join(dir, "settings.json");
    writeFileSync(f, JSON.stringify({ theme: "dark" }));
    const backup = backupConfig(f);
    expect(backup).toBeTruthy();
    expect(JSON.parse(readFileSync(backup!, "utf8"))).toEqual({ theme: "dark" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("never overwrites an earlier backup taken in the same millisecond", () => {
    // Regression: install and uninstall can both call backupConfig within one
    // millisecond (fast CI), and copyFileSync silently replaced the first
    // backup with the second, losing the pre-install copy.
    const dir = tmp();
    const f = path.join(dir, "settings.json");
    writeFileSync(f, JSON.stringify({ theme: "dark" }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const first = backupConfig(f)!;
      writeFileSync(f, JSON.stringify({ theme: "light" }));
      const second = backupConfig(f)!;
      expect(second).not.toBe(first);
      // The first backup still holds what the config held at that moment --
      // the second call did not clobber it.
      expect(JSON.parse(readFileSync(first, "utf8"))).toEqual({ theme: "dark" });
      expect(JSON.parse(readFileSync(second, "utf8"))).toEqual({ theme: "light" });
    } finally {
      vi.useRealTimers();
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("event-key hygiene", () => {
  it("drops an event key we emptied, so a rename leaves nothing dead behind", () => {
    // How the codex snake_case entries were first wired. After correcting the
    // event names, the old keys must not linger as empty arrays.
    const stale = {
      hooks: {
        pre_tool_use: [{ hooks: [{ type: "command", command: "/Users/x/.bb/agent-hooks/guard-bash.sh" }] }],
      },
    };
    const out = planUninstall(stale);
    expect(out.hooks.pre_tool_use).toBeUndefined();
  });

  it("keeps an empty array we did not create", () => {
    const original = { hooks: { Stop: [{ matcher: "", hooks: [] }], Other: [] } };
    const out = planUninstall(original);
    expect(out.hooks.Stop).toEqual([{ matcher: "", hooks: [] }]);
    expect(out.hooks.Other).toEqual([]);
  });
});

describe("tolerating shapes we did not write", () => {
  it("treats an empty or whitespace-only file as an existing empty config", () => {
    const dir = tmp();
    const f = path.join(dir, "settings.json");
    writeFileSync(f, "  \n");
    expect(readConfig(f)).toEqual({ existed: true, data: {} });
    rmSync(dir, { recursive: true, force: true });
  });

  it("has nothing to back up when the config does not exist", () => {
    const dir = tmp();
    expect(backupConfig(path.join(dir, "nope.json"))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the config directory on first write", () => {
    const dir = tmp();
    const f = path.join(dir, "a", "b", "hooks.json");
    writeConfigAtomic(f, { hooks: {} });
    expect(readFileSync(f, "utf8")).toBe('{\n  "hooks": {}\n}\n');
    rmSync(dir, { recursive: true, force: true });
  });

  it("plans from a null or hook-less config", () => {
    expect(countOurs(planClaude(null))).toBe(expectedCount());
    expect(countOurs(planCodex({ theme: "dark" }))).toBe(expectedCount());
    expect(planUninstall(null)).toEqual({ hooks: {} });
    expect(countOurs(null)).toBe(0);
  });

  it("dispatches on kind and the uninstall flag", () => {
    const codex = plan("codex", { hooks: {} });
    expect(JSON.stringify(codex)).toContain("codex-shim.sh");
    expect(JSON.stringify(plan("claude", { hooks: {} }))).not.toContain("codex-shim.sh");
    expect(countOurs(plan("codex", codex, { uninstall: true }))).toBe(0);
  });

  it("passes through non-array event values and malformed groups untouched", () => {
    // Regression: a group whose `hooks` was a non-array value made stripOurs
    // throw "(...).some is not a function", aborting install mid-way.
    const odd = {
      hooks: {
        Weird: { not: "an array" },
        PreToolUse: [
          { matcher: "x" },
          { matcher: "y", hooks: "nope" },
          { matcher: "z", hooks: { not: "an array" } },
          { hooks: [null, { type: "command" }] },
        ],
      },
    };
    const installed = planClaude(odd);
    expect(installed.hooks.Weird).toEqual({ not: "an array" });
    expect(installed.hooks.PreToolUse.slice(0, 4)).toEqual(odd.hooks.PreToolUse);
    expect(countOurs(installed)).toBe(expectedCount());
    const removed = planUninstall(installed);
    expect(removed).toEqual(odd);
  });

  it("strips our entry from a group it shares with a neighbour, keeping the neighbour", () => {
    const shared = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "/Users/x/.bb/agent-hooks/guard-bash.sh" },
              { type: "command", command: "/usr/local/bin/other-guard" },
            ],
          },
        ],
      },
    };
    expect(planUninstall(shared)).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/other-guard" }] }] },
    });
  });

  it("does not mutate its input", () => {
    const input = { hooks: { Stop: [{ hooks: [{ type: "command", command: "/x/zclean" }] }] } };
    const snapshot = structuredClone(input);
    planClaude(input);
    planUninstall(planCodex(input));
    expect(input).toEqual(snapshot);
  });
});
