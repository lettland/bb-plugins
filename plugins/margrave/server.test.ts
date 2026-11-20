import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi, PluginCliRegistration } from "@get-bb/plugin-sdk";
import plugin from "./server.js";

const exec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: exec }));
let cli: PluginCliRegistration;
let listSkills: (
  input: null,
  context: { experimental_signal: AbortSignal },
) => Promise<{ ok: boolean; skills?: unknown; error?: string }>;
const rpcContext = { experimental_signal: new AbortController().signal };
beforeEach(() => {
  exec.mockReset();
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
});
function respond(error: unknown, stdout = "") {
  exec.mockImplementation((_file, _args, _options, callback) =>
    callback(error, stdout, ""),
  );
}

describe("Margrave CLI and RPC", () => {
  it("forwards only fixed arguments and preserves text and JSON", async () => {
    respond(null, "output\n");
    expect((await cli.run(["list"], {})).stdout).toBe("output\n");
    expect(exec.mock.calls[0]?.slice(0, 2)).toEqual([
      "margrave",
      ["list", "--skills"],
    ]);
    expect((await cli.run(["list", "--json"], {})).stdout).toBe("output\n");
    expect(exec.mock.calls[1]?.[1]).toEqual(["list", "--skills", "--json"]);
  });
  it("does not start a process for help or invalid arguments", async () => {
    expect((await cli.run(["list", "--help"], {})).exitCode).toBe(0);
    expect((await cli.run(["list", "bad"], {})).exitCode).not.toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });
  it.each([
    ["ENOENT", "Margrave is unavailable"],
    ["EFAIL", "Could not read"],
  ])("reports %s in text and JSON", async (code, message) => {
    respond(Object.assign(new Error("secret"), { code }));
    for (const args of [["list"], ["list", "--json"]]) {
      const result = await cli.run(args, {});
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain("secret");
      if (args.includes("--json")) expect(result.stdout).toContain(message);
    }
  });
  it("returns only skill fields and rejects malformed catalogs", async () => {
    respond(
      null,
      JSON.stringify({
        sources: [{ secret: true }],
        skills: [{ id: "a/b", name: "b", description: "c", extra: true }],
      }),
    );
    expect(await listSkills(null, rpcContext)).toEqual({
      ok: true,
      skills: [{ id: "a/b", name: "b", description: "c" }],
    });
    expect(exec.mock.calls[0]?.[2].signal).toBe(rpcContext.experimental_signal);
    for (const value of ["not json", '{"skills":[{}]}']) {
      respond(null, value);
      expect(await listSkills(null, rpcContext)).toEqual({
        ok: false,
        error: "invalid",
      });
    }
  });
  it.each([
    ["ENOENT", "missing"],
    ["EFAIL", "failed"],
  ])("classifies RPC failure %s", async (code, error) => {
    respond(Object.assign(new Error("secret"), { code }));
    expect(await listSkills(null, rpcContext)).toEqual({ ok: false, error });
  });
});
