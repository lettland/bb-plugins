import { describe, expect, it } from "vitest";
import {
  commandOf,
  gitCommand,
  globMatcher,
  globQualifies,
  lexCommands,
} from "./detect-mentions.js";

const LIMIT = 8_192;

function shapes(text: string) {
  return lexCommands(text, LIMIT).map(({ words, redirects, heredocs }) => ({
    words: words.map(({ text: word }) => word),
    redirects: redirects.map(({ text: target }) => target),
    heredocs,
  }));
}

describe("lexCommands", () => {
  it("cuts a heredoc body out and keeps the command that read it", () => {
    const text = [
      "cat > lib/new.ts <<'EOF'",
      "echo x > lib/c.ts",
      "it's an apostrophe",
      "import * as x from 'y'",
      "**bold**",
      "EOF",
      "sed -n 1p lib/d.ts",
    ].join("\n");
    expect(shapes(text)).toEqual([
      {
        words: ["cat"],
        redirects: ["lib/new.ts"],
        heredocs: ["echo x > lib/c.ts\nit's an apostrophe\nimport * as x from 'y'\n**bold**"],
      },
      { words: ["sed", "-n", "1p", "lib/d.ts"], redirects: [], heredocs: [] },
    ]);
  });

  it("reads a heredoc operator before the redirect, with a dash and an unquoted tag", () => {
    expect(shapes("cat <<-EOF > lib/new.ts\n\tbody > lib/c.ts\n\tEOF\nls")).toEqual([
      { words: ["cat"], redirects: ["lib/new.ts"], heredocs: ["\tbody > lib/c.ts"] },
      { words: ["ls"], redirects: [], heredocs: [] },
    ]);
  });

  it("runs an unterminated heredoc to the end of the text", () => {
    expect(shapes("python3 - <<EOF\nprint(1)\nprint(2)")).toEqual([
      { words: ["python3", "-"], redirects: [], heredocs: ["print(1)\nprint(2)"] },
    ]);
  });

  it("never reads a quoted `>` as a redirect", () => {
    expect(shapes("rg '=>' lib/c.ts")).toEqual([{ words: ["rg", "=>", "lib/c.ts"], redirects: [], heredocs: [] }]);
    expect(shapes('echo "a > b"')).toEqual([{ words: ["echo", "a > b"], redirects: [], heredocs: [] }]);
  });

  it("takes the target of `>`, `>>`, fd and `&>` redirects and none from fd duplication", () => {
    expect(shapes("a > x; b >> y; c 2> z; d &> w; e 2>&1; f >&2")).toEqual([
      { words: ["a"], redirects: ["x"], heredocs: [] },
      { words: ["b"], redirects: ["y"], heredocs: [] },
      { words: ["c"], redirects: ["z"], heredocs: [] },
      { words: ["d"], redirects: ["w"], heredocs: [] },
      { words: ["e"], redirects: [], heredocs: [] },
      { words: ["f"], redirects: [], heredocs: [] },
    ]);
  });

  it("splits at separators outside quotes and keeps the empty quoted word", () => {
    expect(shapes("a && b | c || d; (e)\nf '' 'g;h'")).toEqual([
      { words: ["a"], redirects: [], heredocs: [] },
      { words: ["b"], redirects: [], heredocs: [] },
      { words: ["c"], redirects: [], heredocs: [] },
      { words: ["d"], redirects: [], heredocs: [] },
      { words: ["e"], redirects: [], heredocs: [] },
      { words: ["f", "", "g;h"], redirects: [], heredocs: [] },
    ]);
  });

  it("drops the word after an input redirect from the words and keeps it as an input", () => {
    expect(shapes("sort < in.txt > out.txt")).toEqual([{ words: ["sort"], redirects: ["out.txt"], heredocs: [] }]);
    expect(lexCommands("sort < in.txt", LIMIT)[0]?.inputs.map(({ text }) => text)).toEqual(["in.txt"]);
  });

  it("reads only the first characters it is given", () => {
    expect(shapes("a > x\nb > y".padEnd(20, " ")).length).toBe(2);
    expect(lexCommands("a > x\nb > y", 9).map(({ redirects }) => redirects.length)).toEqual([1, 0]);
  });
});

describe("commandOf and gitCommand", () => {
  const words = (text: string) => lexCommands(text, LIMIT)[0]?.words ?? [];

  it("skips assignments and leading words and takes the base name", () => {
    expect(commandOf(words("FOO=1 sudo /usr/bin/sed -i x"))).toEqual({
      word: "/usr/bin/sed",
      name: "sed",
      args: [
        { text: "-i", quoted: false },
        { text: "x", quoted: false },
      ],
    });
    expect(commandOf(words("FOO=1"))).toBeNull();
  });

  it("skips git's own options", () => {
    expect(gitCommand(commandOf(words("git -C sub -c a=b --no-pager restore x"))?.args ?? [])?.sub).toBe("restore");
  });
});

describe("globMatcher", () => {
  it("matches `*`, `?` and classes within a segment only", () => {
    const matches = globMatcher("lib/react/*.test.tsx");
    expect(matches("lib/react/a.test.tsx")).toBe(true);
    expect(matches("lib/react/deep/a.test.tsx")).toBe(false);
    expect(matches("lib/react/a.test.ts")).toBe(false);
    expect(globMatcher("lib/?.ts")("lib/a.ts")).toBe(true);
    expect(globMatcher("lib/[ab].ts")("lib/b.ts")).toBe(true);
    expect(globMatcher("lib/[!ab].ts")("lib/b.ts")).toBe(false);
    expect(globMatcher("lib/[a-c].ts")("lib/c.ts")).toBe(true);
  });

  it("lets `**` span segments, including none", () => {
    expect(globMatcher("lib/**/x.ts")("lib/x.ts")).toBe(true);
    expect(globMatcher("lib/**/x.ts")("lib/a/b/x.ts")).toBe(true);
    expect(globMatcher("lib/**/x.ts")("lib/a/b/y.ts")).toBe(false);
    expect(globMatcher("**")("a/b")).toBe(true);
  });

  it("finishes a pathological pattern fast", () => {
    const pattern = `lib/${"*a".repeat(40)}b`;
    const started = Date.now();
    expect(globMatcher(pattern)(`lib/${"a".repeat(200)}`)).toBe(false);
    expect(globMatcher(`lib/${"**/".repeat(40)}x.ts`)(`lib/${"d/".repeat(60)}y.ts`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("globQualifies", () => {
  it.each(["lib/react/*.test.tsx", "lib/*.ts", "lib/**/x.ts", "lib/a*/b?.ts"])("accepts %s", (glob) => {
    expect(globQualifies(glob)).toBe(true);
  });

  it.each(["*", "**", "*.ts", "*/x.ts", "**/x.ts", "lib/*", "lib/**", "lib/*.*", "lib*/x.ts", "/x.ts"])(
    "rejects %s",
    (glob) => {
      expect(globQualifies(glob)).toBe(false);
    },
  );

  it("rejects a glob past the length cap", () => {
    expect(globQualifies(`lib/${"a*".repeat(200)}.ts`)).toBe(false);
  });
});
