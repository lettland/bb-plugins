import { describe, expect, it } from "vitest";
import { globMatcher, globQualifies } from "./detect-globs.js";
import { commandOf, commandStart, gitCommand, lexCommands, lexText } from "./detect-mentions.js";

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

  it("serves a heredoc inside a command-less quoted substitution as an empty command", () => {
    expect(shapes('cat "$( <<EOF\nbody\nEOF\n)"')).toEqual([
      { words: [], redirects: [], heredocs: ["body"] },
      { words: ["cat", "$(   \n)"], redirects: [], heredocs: [] },
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

  it("reads a `<<` inside quotes, a here-string and a comment as no heredoc", () => {
    expect(shapes('grep -n "<<EOF" x.sh\nls')).toEqual([
      { words: ["grep", "-n", "<<EOF", "x.sh"], redirects: [], heredocs: [] },
      { words: ["ls"], redirects: [], heredocs: [] },
    ]);
    expect(shapes("cat <<<word\nls").map(({ words }) => words)).toEqual([["cat"], ["ls"]]);
    expect(shapes("ls # cat <<EOF\nwc")).toEqual([
      { words: ["ls"], redirects: [], heredocs: [] },
      { words: ["wc"], redirects: [], heredocs: [] },
    ]);
  });

  it("reads the `<<\\EOF` tag form", () => {
    expect(shapes("cat <<\\EOF > a.md\nx > b.md\nEOF\nls")).toEqual([
      { words: ["cat"], redirects: ["a.md"], heredocs: ["x > b.md"] },
      { words: ["ls"], redirects: [], heredocs: [] },
    ]);
  });

  it("splits comments from commands, and keeps a `#` inside a word or a quote", () => {
    const lexed = lexText("ls a#b # note\necho '# x' \"#y\" # it's", LIMIT);
    expect(lexed.comments).toEqual([" note", " it's"]);
    expect(lexed.commands.map(({ words }) => words.map(({ text }) => text))).toEqual([
      ["ls", "a#b"],
      ["echo", "# x", "#y"],
    ]);
  });

  it("reports a heredoc with no terminator line", () => {
    expect(lexText("cat <<EOF\nbody", LIMIT).unterminated).toBe(true);
    expect(lexText("cat <<EOF", LIMIT).unterminated).toBe(true);
    expect(lexText("cat <<EOF\nbody\nEOF", LIMIT).unterminated).toBe(false);
    expect(lexText('grep "<<EOF" x', LIMIT).unterminated).toBe(false);
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
    expect(lexCommands("a > x\nb > y", 9).map(({ redirects }) => redirects.length)).toEqual([1]);
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

  it("reads the value of git's directory options, and says when one moved git", () => {
    const git = (text: string) => gitCommand(commandOf(words(text))?.args ?? []);
    expect(git("git --git-dir x/.git --work-tree y restore z")).toMatchObject({ sub: "restore", relocated: true });
    expect(git("git --git-dir=x restore z")).toMatchObject({ sub: "restore", relocated: true });
    expect(git("git -C sub restore z")).toMatchObject({ sub: "restore", relocated: true });
    expect(git("git -c a=b restore z")).toMatchObject({ sub: "restore", relocated: false });
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

describe("lexText edges", () => {
  it("keeps the text of a quoted word that never closes", () => {
    expect(lexText("echo 'abc", LIMIT).commands[0]?.words.map(({ text }) => text)).toEqual(["echo", "abc"]);
  });

  it("reads a duplicate redirect (2>&1) transparently after the command", () => {
    expect(shapes("git show 2>&1 lib/a.ts")).toEqual([
      { words: ["git", "show", "lib/a.ts"], redirects: [], heredocs: [] },
    ],
    );
  });

  it("joins a line continuation into one command", () => {
    expect(shapes("echo a \\\n lib/a.ts")).toEqual([
      { words: ["echo", "a", "lib/a.ts"], redirects: [], heredocs: [] },
    ]);
  });

  it("marks a word quoted that began with a double quote", () => {
    expect(lexText('echo "a b"', LIMIT).commands[0]?.words[1]).toEqual({ text: "a b", quoted: true });
  });

  it("a heredoc whose body never began leaves nothing to read", () => {
    expect(shapes("cat <<EOF")).toEqual([{ words: ["cat"], redirects: [], heredocs: [] }]);
  });

  it("reads a heredoc inside a quoted command substitution against the command that runs it", () => {
    const out = shapes('x="$(cat <<EOF\nbody\nEOF\n)"');
    expect(out.some((shape) => shape.heredocs.includes("body"))).toBe(true);
  });

  it("reads a heredoc of an escaped substitution as its own command text", () => {
    const out = shapes("echo \\$(cat <<EOF\nbody\nEOF\n)");
    expect(out.some((shape) => shape.heredocs.includes("body"))).toBe(true);
  });
});

describe("commandStart", () => {
  it("skips plain wrappers only when asked to", () => {
    const words = [{ text: "time", quoted: false }, { text: "ls", quoted: false }];
    expect(commandStart(words)).toBe(1);
    expect(commandStart(words, false)).toBe(0);
  });
});

describe("gitCommand", () => {
  it("is null when git's options end the command, and reads relocating options", () => {
    expect(gitCommand([{ text: "-C", quoted: false }])).toBeNull();
    expect(
      gitCommand([{ text: "--git-dir", quoted: false }, { text: "/x", quoted: false }, { text: "status", quoted: false }]),
    ).toEqual({
      sub: "status",
      rest: [],
      relocated: true,
    });
    expect(
      gitCommand([
        { text: "--no-pager", quoted: false },
        { text: "status", quoted: false },
        { text: "origin/main", quoted: false },
      ]),
    ).toEqual({
      sub: "status",
      rest: [{ text: "origin/main", quoted: false }],
      relocated: false,
    });
  });
});

describe("lexText: substitutions at the edges", () => {
  it("a substitution that opens the text reads its commands, then carries on", () => {
    const shapesOut = shapes("$(cat <<EOF\nbody\nEOF\n) lib/a.ts");
    expect(shapesOut[0]).toEqual({ words: ["cat"], redirects: [], heredocs: ["body"] });
    expect(shapesOut.at(-1)?.words).toContain("lib/a.ts");
  });

  it("a quoted heredoc whose body never began leaves no commands behind", () => {
    const lexed = lexText('x="$(cat <<EOF', LIMIT);
    expect(lexed.unterminated).toBe(true);
    expect(lexed.commands.every((command) => command.heredocs.length === 0)).toBe(true);
  });
});
