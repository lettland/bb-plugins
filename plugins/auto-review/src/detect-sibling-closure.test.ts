import { describe, expect, it } from "vitest";
import { lexCommands } from "./detect-mentions.js";
import { siblingWrittenPaths, writeTargets } from "./detect-sibling-writes.js";

const ROOT = "/w";
const both = ["src/a.ts", "a.ts"];

/** What a sibling's rows write to, row by row with `cwd` as real rows carry it (empty), the family having run `family`. */
function credited(candidates: string[], rows: string[], family: string[] = []): string[] {
  const texts = rows.map((text) => ({ threadId: "sib-1", text, cwd: "" }));
  return [...siblingWrittenPaths(candidates, texts, family, ROOT).keys()].sort();
}

describe("a heredoc inside a quoted command substitution belongs to the command inside it", () => {
  const post = `python3 tools/post.py --body "$(cat <<'EOF'\nRepro: open('a.ts','w').write('x')\nEOF\n)"`;
  const comment = `node scripts/comment.js "$(cat <<'EOF'\nfs.writeFileSync('src/a.ts', s)\nEOF\n)"`;

  it.each([
    ["python3", post],
    ["node", comment],
  ])("never reaches the `%s` interpreter, so nothing is credited", (_name, text) => {
    expect(writeTargets(text)).toEqual([]);
    expect(credited(both, [text])).toEqual([]);
  });

  it.each([post, comment])("gives the body to `cat`, which the family side still reads as names", (text) => {
    const [inner, outer] = lexCommands(text, 8_192);
    expect(inner?.words.map(({ text: word }) => word)).toEqual(["cat"]);
    expect(inner?.heredocs).toHaveLength(1);
    expect(inner?.depth).toBe(1);
    expect(outer?.heredocs).toEqual([]);
    expect(credited(["lib/c.ts"], ["echo x > lib/c.ts"], [`node x.js "$(cat <<'EOF'\nsee lib/c.ts\nEOF\n)"`])).toEqual([]);
  });

  it("keeps a plain heredoc on an interpreter, which reads it as its script", () => {
    expect(writeTargets("python3 - <<'EOF'\nopen('a.ts','w').write('x')\nEOF")).toEqual(["a.ts"]);
  });
});

describe("an interpreter script credits only a file-writing call", () => {
  it.each([
    "node -e \"require('fs').appendFileSync('a.ts','x')\"",
    "node -e \"fs.createWriteStream('a.ts').end('x')\"",
    "node -e \"fs.promises.writeFile('a.ts','x')\"",
    "node -e \"fs.writeFile('a.ts','x', cb)\"",
    "python3 -c \"from pathlib import Path; Path('a.ts').write_bytes(b'x')\"",
    "python3 -c \"from pathlib import Path; Path('a.ts').write_text('x')\"",
    "python3 -c \"from pathlib import Path; Path('a.ts').open('w').write('x')\"",
    "python3 -c \"open('a.ts','a').write('x')\"",
    "python3 -c \"open('a.ts','x').write('x')\"",
    "python3 -c \"open('a.ts','w+').write('x')\"",
    "python3 -c \"p='a.ts'; f=open(p,'w'); f.write(s)\"",
  ])("`%s` writes a.ts", (text) => {
    expect(credited(["a.ts", "b.ts"], [text])).toEqual(["a.ts"]);
  });

  it.each([
    "python3 -c \"import sys; sys.stdout.write(open('README.md').read())\"",
    "node -e \"process.stdout.write(fs.readFileSync('README.md', 'utf8'))\"",
    "node -e \"res.write(fs.readFileSync('README.md'))\"",
    "python3 -c \"print(open('README.md').read())\"",
  ])("`%s` writes no file", (text) => {
    expect(credited(["README.md"], [text])).toEqual([]);
  });
});

describe("a text cut at the limit", () => {
  const long = `: ${"x".repeat(9_000)}\ncd src`;

  it("leaves the shell unknown, since a `cd` may sit past the cut", () => {
    expect(credited(both, [long, "echo x > a.ts"])).toEqual([]);
    expect(credited(both, [": x\ncd /w", "echo x > a.ts"])).toEqual(["a.ts"]);
  });

  it("still resolves an absolute target afterwards", () => {
    expect(credited(both, [long, "echo x > /w/src/a.ts"])).toEqual(["src/a.ts"]);
  });
});

describe("heredoc tags", () => {
  it.each(["<<1EOF", "<<-1EOF", "<<'END TEXT'", '<<"END TEXT"', "<<\\1EOF"])("`%s` opens a heredoc, whose body is not commands", (operator) => {
    const tag = operator.includes("END") ? "END TEXT" : "1EOF";
    const text = `cat ${operator} > notes.md\necho x > a.ts\n${tag}\necho y > b.ts`;
    expect(writeTargets(text)).toEqual(["notes.md", "b.ts"]);
  });
});

describe("git's location exported by a sibling", () => {
  const checkout = "git checkout -- a.ts";

  it.each(["export GIT_WORK_TREE=/other", "export GIT_DIR=/other/.git", "GIT_DIR=/other/.git"])("`%s` makes its later git targets unresolvable", (text) => {
    expect(credited(["a.ts"], [checkout])).toEqual(["a.ts"]);
    expect(credited(["a.ts"], [text, checkout])).toEqual([]);
    expect(credited(["a.ts"], [`${text} && ${checkout}`])).toEqual([]);
    expect(credited(["a.ts"], [text, "echo x > a.ts"])).toEqual(["a.ts"]);
  });

  it("leaves another sibling's git alone", () => {
    const texts = [
      { threadId: "sib-1", text: "export GIT_DIR=/other/.git", cwd: "" },
      { threadId: "sib-2", text: checkout, cwd: "" },
    ];
    expect([...siblingWrittenPaths(["a.ts"], texts, [], ROOT).keys()]).toEqual(["a.ts"]);
  });
});

describe("a cd through a builtin or command prefix", () => {
  it.each(["builtin cd src", "command cd src"])("`%s` moves the shell", (text) => {
    expect(credited(both, [text, "echo x > a.ts"])).toEqual([]);
  });
});

describe("parentheses that are not substitutions keep the depth and the substitutions straight", () => {
  it.each([
    ["x=$((1 + 2)); echo $x > a.ts", [2, 0, 0], true],
    ["echo $((1 + (2 * 3))) > a.ts", [3, 3, 0], true],
    ["echo $(( $(wc -l < f) + 1 )) > a.ts", [3, 2, 0], true],
    ["case $x in a) echo y > a.ts;; b) cd src;; esac", [0, 0, 0, 0, 0], false],
    ["case $x in (a) echo y > a.ts;; esac", [1, 1, 0, 0], true],
    ["arr=(a b c); echo ${arr[0]} > a.ts", [1, 1, 0], true],
    ["arr=(cd src); echo x > a.ts", [1, 1, 0], true],
    ["(cd src; echo x > a.ts); echo y > b.ts", [1, 1, 0], true],
  ])("`%s`", (text, depths, shellStaysAtRoot) => {
    expect(lexCommands(text, 8_192).map(({ depth }) => depth)).toEqual(depths);
    // What follows is read at the top level again, and only a `cd` outside every parenthesis moves the shell.
    expect(lexCommands(`${text}\necho z > c.ts`, 8_192).at(-1)).toMatchObject({ depth: 0 });
    expect(credited(["z.ts", "src/z.ts"], [text, "echo x > z.ts"])).toEqual(shellStaysAtRoot ? ["z.ts"] : []);
  });
});
