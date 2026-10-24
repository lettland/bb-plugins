import { describe, expect, it } from "vitest";
import { literalWriteTargets, scriptTokens } from "./detect-script-writes.js";

const word = (text: string) => ({ text, quoted: false });

describe("literalWriteTargets", () => {
  it("names the literal targets of a script that only writes literals", () => {
    expect(literalWriteTargets("f = open('lib/a.ts', 'w')\nwriteFileSync('lib/b.ts', data)")).toEqual([
      "lib/a.ts",
      "lib/b.ts",
    ]);
    expect(literalWriteTargets("Path('lib/c.ts').write_text(x)")).toEqual(["lib/c.ts"]);
  });

  it("is null when a target is built instead of named", () => {
    expect(literalWriteTargets("open(p, 'w').write(x)")).toBeNull();
  });

  it("is null when nothing writes", () => {
    expect(literalWriteTargets("print(open('lib/a.ts').read())")).toBeNull();
  });
});

describe("scriptTokens", () => {
  it("reads the literal targets of a heredoc script, and of a -c string", () => {
    const body = "f = open('lib/a.ts', 'w')\nwriteFileSync('lib/b.ts', data)";
    expect(scriptTokens([], [body])).toEqual(["lib/a.ts", "lib/b.ts"]);
    expect(scriptTokens([word("python3"), word("-c"), word("writeFileSync('lib/c.ts', d)")], [])).toEqual([
      "lib/c.ts",
    ]);
  });

  it("falls back to every word of a script that builds a target", () => {
    const body = "p = 'lib/d.ts'\nopen(p, 'w').write(x)";
    expect(scriptTokens([], [body])).toEqual(["p", "lib/d.ts", "open", "p", "w", ".write", "x"]);
  });

  it("keeps no tokens for a body that writes nothing, and nothing for a flag with no value", () => {
    expect(scriptTokens([], ["print(open('lib/a.ts').read())"])).toEqual([]);
    expect(scriptTokens([word("python3"), word("-c")], [])).toEqual([]);
    expect(scriptTokens([word("python3"), word("-f"), word("x")], ["f = open('lib/a.ts', 'w')"])).toEqual([
      "lib/a.ts",
    ]);
  });
});
