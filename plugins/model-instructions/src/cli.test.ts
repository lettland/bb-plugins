import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { snapshotOf } from "./cache-fixture.js";
import { runCli, USAGE, type CliDeps, type ConfigCli } from "./cli.js";
import type { Caches } from "./projects.js";
import { parseRawConfig, type RawConfig } from "./rules.js";

// The plugin always finishes one refresh at startup, so a list that is neither loaded nor failed is
// only reachable here, with hand-made state.
function depsFor(snapshot: ReturnType<typeof snapshotOf>): CliDeps {
  return {
    rules: () => [],
    scopes: () => [],
    skills: () => [],
    caches: { snapshot: () => snapshot } as unknown as Caches,
    overBudget: () => [],
    events: () => [],
    threads: {
      get: async () => {
        throw new Error("unused");
      },
      defaultExecutionOptions: async () => null,
    },
    profiles: () => ({ state: "absent" }),
    profilesFile: "/profiles.json",
    ignoredSettingScopes: () => [],
    profile: { kv: { list: async () => [] } } as unknown as CliDeps["profile"],
    setup: {} as CliDeps["setup"],
    importDirSkills: {} as CliDeps["importDirSkills"],
    config: {} as CliDeps["config"],
  };
}

describe("status: cache state", () => {
  it.each([
    [{ loaded: false, failed: false }, "not loaded"],
    [{ loaded: false, failed: true }, "not loaded, last refresh failed"],
    [{ loaded: true, failed: true }, "loaded, last refresh failed"],
    [{ loaded: true, failed: false }, "loaded"],
  ])("words %j as %s", async (state, text) => {
    const result = await runCli(["status"], {}, depsFor(snapshotOf([], [], { providers: state })));
    expect(result.stdout).toContain(`cache: provider list ${text}; project list loaded`);
  });
});

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "model-instructions-cli-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SAVED: RawConfig = parseRawConfig({
  vars: { a: "A" },
  scopes: [{ name: "w", paths: ["/w"] }],
  rules: [{ name: "r", plugins: ["example-*"], instructions: "use {{a}}" }],
});

function configFake(over: Partial<ConfigCli> = {}) {
  const imported: unknown[] = [];
  const config: ConfigCli = {
    saved: () => SAVED,
    storedText: () => undefined,
    storageFailed: () => false,
    async importConfig(value) {
      imported.push(value);
      return { saved: parseRawConfig(value) };
    },
    ...over,
  };
  return { config, imported };
}

const withConfig = (config: ConfigCli): CliDeps => ({ ...depsFor(snapshotOf([], [])), config });

describe("export", () => {
  it("prints the saved config as JSON, and nothing else", async () => {
    const result = await runCli(["export"], {}, withConfig(configFake().config));
    expect(result).toEqual({ exitCode: 0, stdout: JSON.stringify(SAVED, null, 2) + "\n" });
  });

  it("prints the stored value instead of the empty config while the stored config failed to load", async () => {
    const stored = JSON.stringify({ rules: [{ project: 1 }] }, null, 2);
    const { config } = configFake({ saved: () => ({ vars: {}, scopes: [], rules: [] }), storedText: () => stored });
    expect(await runCli(["export"], {}, withConfig(config))).toEqual({
      exitCode: 0,
      stdout: stored + "\n",
      stderr: "export: the saved config could not be loaded; this is the stored value, not the active config\n",
    });
  });

  it("refuses while the plugin's storage could not be read, so an empty config is never exported as a backup", async () => {
    const { config } = configFake({ storageFailed: () => true });
    expect(await runCli(["export"], {}, withConfig(config))).toEqual({
      exitCode: 1,
      stderr:
        "export: the plugin's storage could not be read at start; reload the plugin (bb plugin reload model-instructions) first\n",
    });
  });

  it("prints nothing on stderr when the stored config loaded", async () => {
    expect((await runCli(["export"], {}, withConfig(configFake().config))).stderr).toBeUndefined();
  });

  it("rejects any other argument, --json included, with the usage line", async () => {
    for (const args of [["--json"], ["--legacy"]]) {
      const result = await runCli(["export", ...args], {}, withConfig(configFake().config));
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe(`export: unknown argument "${args[0]}"\nusage: ${USAGE}\n`);
    }
  });
});

describe("import", () => {
  const write = (name: string, text: string | Buffer) => {
    const file = path.join(tmp, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  const doImport = (args: string[], ctx: { cwd?: string } = {}, config = configFake()) =>
    runCli(["import", ...args], ctx, withConfig(config.config));

  it("takes exactly one path", async () => {
    for (const args of [[], ["a.json", "b.json"]]) {
      const result = await doImport(args);
      expect(result).toEqual({ exitCode: 2, stderr: `import: give one file path\nusage: ${USAGE}\n` });
    }
  });

  it("imports an absolute path, hands the parsed JSON to the one write path, and reports the counts", async () => {
    const file = write("abs/config.json", JSON.stringify(SAVED));
    const fake = configFake();
    const result = await doImport([file], {}, fake);
    expect(result).toEqual({ exitCode: 0, stdout: `imported ${file}: 1 rules, 1 scopes, 1 vars\n` });
    expect(fake.imported).toEqual([SAVED]);
  });

  it("resolves a relative path against the CLI's working directory", async () => {
    const file = write("rel/config.json", JSON.stringify(SAVED));
    const fake = configFake();
    const result = await doImport(["config.json"], { cwd: path.dirname(file) }, fake);
    expect(result.stdout).toBe(`imported ${file}: 1 rules, 1 scopes, 1 vars\n`);
    expect(fake.imported).toEqual([SAVED]);
  });

  it("rejects a relative path when no working directory is known, and reads nothing", async () => {
    const fake = configFake();
    const result = await doImport(["config.json"], {}, fake);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("import: config.json is a relative path and no working directory is known; give an absolute path");
    expect(fake.imported).toEqual([]);
  });

  it("follows a symlink to a regular file", async () => {
    const file = write("link/target.json", JSON.stringify(SAVED));
    const link = path.join(path.dirname(file), "link.json");
    symlinkSync(file, link);
    expect((await doImport([link])).exitCode).toBe(0);
  });

  it("rejects a file that is not JSON as 'not valid JSON', without echoing a byte of it", async () => {
    const file = write("bad/secret.json", '{"token": "SECRET-VALUE-123", oops');
    const fake = configFake();
    const result = await doImport([file], {}, fake);
    expect(result).toEqual({ exitCode: 1, stderr: `import: ${file}: not valid JSON\n` });
    expect(JSON.stringify(result)).not.toContain("SECRET-VALUE-123");
    expect(fake.imported).toEqual([]);
  });

  it("hands the array form of the previous versions to the write path as the object form", async () => {
    const file = write("array/rules.json", JSON.stringify([{ name: "r", instructions: "x" }]));
    const fake = configFake();
    expect(await doImport([file], {}, fake)).toEqual({
      exitCode: 0,
      stdout: `imported ${file}: 1 rules, 0 scopes, 0 vars\n`,
    });
    expect(fake.imported).toEqual([{ rules: [{ name: "r", instructions: "x" }] }]);
  });

  it("reports what the write path rejects", async () => {
    const file = write("rejected/config.json", "{}");
    const fake = configFake({
      importConfig: async () => {
        throw new Error('rules[0]: scope "x" matches no defined scope');
      },
    });
    expect(await doImport([file], {}, fake)).toEqual({
      exitCode: 1,
      stderr: 'import: rules[0]: scope "x" matches no defined scope\n',
    });
  });

  it("rejects a directory", async () => {
    const dir = path.join(tmp, "a-directory");
    mkdirSync(dir);
    expect(await doImport([dir])).toEqual({ exitCode: 1, stderr: `import: ${dir} is not a regular file\n` });
  });

  it("rejects a file that is not there, naming the path", async () => {
    const missing = path.join(tmp, "missing.json");
    const result = await doImport([missing]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`^import: could not read ${missing}: ENOENT`));
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO at once instead of waiting for a writer", async () => {
    const fifo = path.join(tmp, "pipe.fifo");
    execFileSync("mkfifo", [fifo]);
    const result = await doImport([fifo]);
    expect(result).toEqual({ exitCode: 1, stderr: `import: ${fifo} is not a regular file\n` });
  });

  it("reads at most 1 MiB + 1 byte: a file of exactly 1 MiB passes, one byte more is rejected", async () => {
    const pad = (length: number) => Buffer.from('{"rules":[]}'.padEnd(length));
    const exact = write("size/exact.json", pad(1024 * 1024));
    const over = write("size/over.json", pad(1024 * 1024 + 1));
    const huge = write("size/huge.json", pad(3 * 1024 * 1024));
    const fake = configFake();
    expect((await doImport([exact], {}, fake)).exitCode).toBe(0);
    for (const file of [over, huge])
      expect(await doImport([file], {}, fake)).toEqual({ exitCode: 1, stderr: `import: ${file} is larger than 1 MiB\n` });
    expect(fake.imported).toHaveLength(1);
  });

  it("never reads past the limit, however large the file", async () => {
    const huge = write("size/bounded.json", Buffer.alloc(4 * 1024 * 1024, 0x20));
    const spy = vi.spyOn(Buffer, "concat");
    try {
      await doImport([huge]);
      const total = spy.mock.calls[0][0].reduce((sum, chunk) => sum + chunk.length, 0);
      expect(total).toBe(1024 * 1024 + 1);
    } finally {
      spy.mockRestore();
    }
  });
});
