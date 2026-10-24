import { describe, expect, it } from "vitest";
import { unwrap } from "./detect-wrappers.js";

const word = (text: string) => ({ text, quoted: false });

describe("unwrap", () => {
  it("looks through a wrapper's options and values to the command it runs", () => {
    const inner = unwrap([word("timeout"), word("300"), word("npm"), word("install")]);
    expect(inner?.words.map(({ text }) => text)).toEqual(["npm", "install"]);
    expect(inner?.parsed).toMatchObject({ word: "npm", name: "npm", wrapped: true });
  });

  it("reads a wrapper's option values and skips env assignments", () => {
    const inner = unwrap([word("env"), word("-u"), word("DEBUG"), word("FOO=1"), word("git"), word("status")]);
    expect(inner?.words.map(({ text }) => text)).toEqual(["git", "status"]);
  });

  it("a -- in the wrapper's arguments hands the rest over untouched", () => {
    const inner = unwrap([word("sudo"), word("--"), word("rm"), word("-rf"), word("tmp/x")]);
    expect(inner?.words.map(({ text }) => text)).toEqual(["rm", "-rf", "tmp/x"]);
  });

  it("a subcommand that is not a wrapper's leaves the command alone", () => {
    const inner = unwrap([word("pnpm"), word("install")]);
    expect(inner?.words.map(({ text }) => text)).toEqual(["pnpm", "install"]);
    expect(inner?.parsed).toMatchObject({ name: "pnpm", wrapped: false });
  });

  it("follows wrappers chained inside wrappers", () => {
    const inner = unwrap([word("nohup"), word("npx"), word("-p"), word("left-pad"), word("node"), word("build.js")]);
    expect(inner?.words.map(({ text }) => text)).toEqual(["node", "build.js"]);
  });

  it("is null for an empty line and for assignments alone", () => {
    expect(unwrap([])).toBeNull();
    expect(unwrap([word("FOO=1"), word("BAR=2")])).toBeNull();
  });
});

describe("unwrap: a value option that ends the wrapper", () => {
  it("leaves the command alone when the subcommand position is past the end", () => {
    const inner = unwrap([word("pnpm"), word("--filter")]);
    expect(inner?.words.map(({ text }) => text)).toEqual(["pnpm", "--filter"]);
    expect(inner?.parsed).toMatchObject({ name: "pnpm", wrapped: false });
  });
});
