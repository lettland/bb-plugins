import { describe, expect, it } from "vitest";
import { packageWords } from "./detect-packages.js";

const word = (text: string) => ({ text, quoted: false });

describe("packageWords", () => {
  it("keeps the words from the subcommand on", () => {
    expect(packageWords("npm", [word("run"), word("format")])).toEqual(["run", "format"]);
  });

  it("skips a global option and its value", () => {
    expect(packageWords("npm", [word("--prefix"), word("web"), word("install")])).toEqual(["install"]);
    expect(packageWords("pnpm", [word("--filter"), word("web"), word("run"), word("format")])).toEqual(["run", "format"]);
    expect(packageWords("yarn", [word("--cwd"), word("web"), word("fix")])).toEqual(["fix"]);
    expect(packageWords("bun", [word("--filter"), word("web"), word("test")])).toEqual(["test"]);
  });

  it("does not treat another package manager's option as a value option", () => {
    expect(packageWords("npm", [word("--filter"), word("web"), word("install")])).toEqual([
      "web",
      "install",
    ]);
  });

  it("does not skip a value option that ends the command", () => {
    expect(packageWords("npm", [word("install"), word("--prefix")])).toEqual(["install"]);
  });

  it("stops at a bare --, whose words belong to the script", () => {
    expect(packageWords("pnpm", [word("--filter"), word("web"), word("--"), word("-x"), word("build")])).toEqual([]);
    expect(packageWords("npm", [word("run"), word("--"), word("x")])).toEqual(["run"]);
  });

  it("drops yarn's workspace selector", () => {
    expect(packageWords("yarn", [word("workspace"), word("web"), word("fix")])).toEqual(["fix"]);
    expect(packageWords("yarn", [word("workspaces"), word("foreach"), word("run"), word("fix")])).toEqual([
      "run",
      "fix",
    ]);
  });
});
