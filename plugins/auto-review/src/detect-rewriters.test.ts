import { describe, expect, it } from "vitest";
import { lexText } from "./detect-mentions.js";
import { isReader, rewritesTree, shellScript, writesFiles } from "./detect-rewriters.js";
import { unwrap } from "./detect-wrappers.js";

const parse = (text: string) => {
  const command = lexText(text, 65_536).commands[0];
  return command === undefined ? null : (unwrap(command.words)?.parsed ?? null);
};
const word = (text: string) => ({ text, quoted: false });

describe("isReader", () => {
  it("reads its git subcommand, and a git without one reads as no reader", () => {
    expect(isReader(parse("git status")!)).toBe(true);
    expect(isReader(parse("git log")!)).toBe(true);
    expect(isReader(parse("git --version")!)).toBe(false);
  });
});

describe("rewritesTree", () => {
  it("a git submodule subcommand rewrites only in update and foreach", () => {
    expect(rewritesTree(parse("git submodule update --init")!)).toBe(true);
    expect(rewritesTree(parse("git submodule foreach pnpm i")!)).toBe(true);
    expect(rewritesTree(parse("git submodule --quiet")!)).toBe(false);
    expect(rewritesTree(parse("git submodule status")!)).toBe(false);
  });

  it("a package manager with only value options changes nothing", () => {
    expect(rewritesTree(parse("npm --prefix")!)).toBe(false);
    expect(rewritesTree(parse("pnpm --filter web run format")!)).toBe(true);
  });

  it("a script runner given a file after -- runs the file, whatever the file does", () => {
    expect(rewritesTree(parse("node -- scripts/gen.ts")!)).toBe(true);
    expect(rewritesTree(parse("node -- scripts/check.ts")!)).toBe(true);
    expect(rewritesTree(parse("echo scripts/gen.ts")!)).toBe(false);
  });
});

describe("shellScript", () => {
  it("joins an eval's words, takes a shell's -c string, and null without one", () => {
    expect(shellScript({ name: "eval", args: [word("a"), word("b")] } as never)).toBe("a b");
    expect(shellScript({ name: "bash", args: [word("-lc"), word("npm ci")] } as never)).toBe("npm ci");
    expect(shellScript({ name: "bash", args: [word("-c")] } as never)).toBeNull();
    expect(shellScript({ name: "make", args: [] } as never)).toBeNull();
  });
});

describe("writesFiles", () => {
  it("is false without a command, even when a target was named", () => {
    expect(writesFiles(null, false)).toBe(false);
  });

  it("is false for a git command without a readable subcommand", () => {
    expect(writesFiles(parse("git --version"), false)).toBe(false);
  });
});
