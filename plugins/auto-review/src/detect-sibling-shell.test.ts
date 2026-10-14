import { describe, expect, it } from "vitest";
import { lexCommands } from "./detect-mentions.js";
import { siblingWrittenPaths, writeTargets } from "./detect-sibling-writes.js";

const ROOT = "/w";

/** What a sibling's rows write to, row by row with `cwd` as real rows carry it (empty), the family having run `family`. */
function credited(candidates: string[], rows: string[], family: string[] = []): string[] {
  const texts = rows.map((text) => ({ threadId: "sib-1", text, cwd: "" }));
  return [...siblingWrittenPaths(candidates, texts, family, ROOT).keys()].sort();
}

describe("where a sibling's shell is after a cd", () => {
  const both = ["src/a.ts", "a.ts"];

  it("is unresolvable after a cd into a subdirectory, so a later relative write credits nothing", () => {
    expect(credited(both, ["cd src", "echo x > a.ts"])).toEqual([]);
    expect(credited(both, ["cd src && ls", "echo x > a.ts"])).toEqual([]);
    expect(credited(both, ["pushd src", "echo x > a.ts"])).toEqual([]);
  });

  it.each(["cd ..", "cd -", "cd", "cd ~", "cd $HOME", 'cd "$(git rev-parse --show-toplevel)"', "cd /elsewhere", "popd"])(
    "is unresolvable after `%s`",
    (text) => {
      expect(credited(both, [text, "echo x > a.ts"])).toEqual([]);
    },
  );

  it("still credits an absolute target under the root while it is unresolvable", () => {
    expect(credited(["src/a.ts"], ["cd src", "echo x > /w/src/a.ts"])).toEqual(["src/a.ts"]);
  });

  it("is the root again after a cd to it, and a cd to `.` keeps it there", () => {
    expect(credited(both, ["cd src", "cd /w", "echo x > a.ts"])).toEqual(["a.ts"]);
    expect(credited(both, ["cd /w/", "echo x > a.ts"])).toEqual(["a.ts"]);
    expect(credited(both, ["cd .", "echo x > a.ts"])).toEqual(["a.ts"]);
  });

  it("is not moved by a cd in a subshell, which still stops its own text", () => {
    const candidates = ["pkg/README.md", "README.md"];
    expect(credited(candidates, ["(cd pkg && npm test)", "echo x > README.md"])).toEqual(["README.md"]);
    expect(credited(candidates, ["echo y > $(cd pkg && pwd)/x", "echo x > README.md"])).toEqual(["README.md"]);
    expect(credited(candidates, ["(cd pkg && echo x > README.md)"])).toEqual([]);
    expect(credited(candidates, ["echo x > README.md && (cd pkg)"])).toEqual(["README.md"]);
  });

  it("is not moved by a cd inside `bash -c`, and is not marked unresolvable by it", () => {
    const candidates = ["pkg/README.md", "README.md"];
    expect(credited(candidates, ["bash -c 'cd pkg && npm test'", "echo x > README.md"])).toEqual(["README.md"]);
  });

  it("resolves a row against its own absolute cwd after a cd", () => {
    const texts = [
      { threadId: "sib-1", text: "cd src", cwd: "" },
      { threadId: "sib-1", text: "echo x > a.ts", cwd: "/w/src" },
    ];
    expect([...siblingWrittenPaths(both, texts, [], ROOT).keys()]).toEqual(["src/a.ts"]);
  });
});

describe("a heredoc inside a quoted command substitution", () => {
  const body =
    "Fix a thing\n\nit's a bug with an unpaired \" quote and\nso echo x > src/a.ts works\n> quoted\n`echo y > src/a.ts`";
  const commit = `git commit -m "$(cat <<'EOF'\n${body}\nEOF\n)"`;
  const pullRequest = `gh pr create --title t --body "$(cat <<'EOF'\n${body}\nEOF\n)"`;

  it.each([
    ["git", commit],
    ["gh", pullRequest],
  ])("is cut before the quotes are read: the `%s` command writes nothing", (command, text) => {
    expect(writeTargets(text)).toEqual([]);
    expect(credited(["src/a.ts"], [text])).toEqual([]);
    expect(lexCommands(text, 8_192).map(({ words }) => words[0]?.text)).toEqual(["cat", command]);
  });

  it("leaves the commands after it readable", () => {
    expect(writeTargets(`${commit} && echo x > b.ts`)).toEqual(["b.ts"]);
    expect(writeTargets(`${pullRequest}\necho x > b.ts`)).toEqual(["b.ts"]);
  });

  it("does not make a `<<` plain text elsewhere a heredoc", () => {
    expect(writeTargets("echo '<<EOF' > notes.md\necho x > b.ts")).toEqual(["notes.md", "b.ts"]);
    expect(writeTargets('echo "a <<EOF" > notes.md\necho x > b.ts')).toEqual(["notes.md", "b.ts"]);
    expect(writeTargets('echo "$(date) <<EOF" > notes.md\necho x > b.ts')).toEqual(["notes.md", "b.ts"]);
  });

  it("still names the paths its body mentions on the family side", () => {
    const mention = `git commit -m "$(cat <<'EOF'\nsee lib/c.ts\nEOF\n)"`;
    expect(credited(["lib/c.ts"], ["echo x > lib/c.ts"], [mention])).toEqual([]);
    expect(credited(["lib/c.ts"], ["echo x > lib/c.ts"], ['git commit -m "see lib/d.ts"'])).toEqual(["lib/c.ts"]);
  });
});

describe("heredoc tags", () => {
  it.each(["END-X", "EOF.1", "E_1", "'END-X'", '"EOF.1"', "\\END-X"])("read `<<%s` and its terminator line", (tag) => {
    const bare = tag.replace(/^['"\\]|['"]$/gu, "");
    const text = `cat > notes.md <<${tag}\necho x > src/a.ts\n${bare}\necho y > b.ts`;
    expect(writeTargets(text)).toEqual(["notes.md", "b.ts"]);
  });

  it("read `<<-` with a tab-indented terminator line", () => {
    expect(writeTargets("cat > notes.md <<-EOF.1\n\techo x > src/a.ts\n\tEOF.1\necho y > b.ts")).toEqual(["notes.md", "b.ts"]);
  });
});

describe("literal write targets of a script", () => {
  const found = ["src/a.ts", "b.ts", "notes.md"];
  const script = (...lines: string[]) => `python3 - <<'EOF'\n${lines.join("\n")}\nEOF`;

  it("stay inside the call's own parentheses: a read with options is no write", () => {
    const text = script("p = 'src/a.ts'", "s = open(p, encoding='utf8').read(); open('b.ts','w').write(s)");
    expect(credited(found, [text])).toEqual(["b.ts"]);
  });

  it("do not borrow the next call's mode: a read of a literal is no write", () => {
    const text = script("s = open('src/a.ts','r').read(); open('b.ts','w').write(s)");
    expect(credited(found, [text])).toEqual(["b.ts"]);
  });

  it("read two calls on one line", () => {
    expect(credited(found, [script("open('b.ts','w').write(x); open('notes.md','a').write(y)")])).toEqual(["b.ts", "notes.md"]);
    expect(credited(found, [script("open(x, 'r').read(); open('b.ts','w'); open('src/a.ts','r')")])).toEqual(["b.ts"]);
  });

  it("fall back to every path the script mentions when a write call's path is not a literal", () => {
    const joined = script("p = 'src/a.ts'", "open(os.path.join(d, n), 'w').write(s); open('b.ts','w').write(s)");
    expect(credited(found, [joined])).toEqual(["b.ts", "src/a.ts"]);
    const cast = script("p = 'src/a.ts'", "open(str(p), 'w').write(s); open('b.ts','w').write(s)");
    expect(credited(found, [cast])).toEqual(["b.ts", "src/a.ts"]);
  });
});

describe("git told where to work by the environment", () => {
  it.each([
    "GIT_DIR=x/.git git restore b.ts",
    "GIT_WORK_TREE=x git checkout -- b.ts",
    "GIT_INDEX_FILE=/tmp/index git restore b.ts",
    "FOO=1 GIT_DIR=x git restore b.ts",
  ])("gives no targets: `%s`", (text) => {
    expect(writeTargets(text)).toEqual([]);
    expect(credited(["b.ts"], [text])).toEqual([]);
  });

  it("leaves other prefixes and a redirect alone", () => {
    expect(writeTargets("FOO=1 git restore b.ts")).toEqual(["b.ts"]);
    expect(writeTargets("GIT_DIR=x git diff > p.diff")).toEqual(["p.diff"]);
  });
});
