import { describe, expect, it } from "vitest";
import { classifyText, opaqueProgram } from "./detect-claim-shell.js";

describe("classifyText: lookups and wrappers", () => {
  it("a command lookup runs nothing", () => {
    const claims = classifyText("command -v git");
    expect(claims).toMatchObject({ opaque: undefined, writes: [], scratch: [], history: false });
  });

  it("a command with no flag is not a lookup, and neither is a lone command", () => {
    expect(classifyText("command ls").writes).toEqual([]);
    expect(classifyText("command").writes).toEqual([]);
  });
});

describe("classifyText: copy and move destinations", () => {
  it("a file destination names the file and each source under it", () => {
    const claims = classifyText("cp lib/a.ts lib/b.ts");
    expect(claims.writes.flatMap(({ tokens }) => tokens)).toEqual(["lib/b.ts", "lib/b.ts/a.ts"]);
  });

  it("a single-file copy names no destination", () => {
    expect(classifyText("cp lib/a.ts").writes).toEqual([]);
  });

  it("a dot source adds nothing under the destination", () => {
    const claims = classifyText("cp . staging");
    expect(claims.writes.flatMap(({ tokens }) => tokens)).toEqual(["staging"]);
  });
});

describe("classifyText: words that run a command inside them", () => {
  it("a backtick word makes the command opaque by substitution", () => {
    const claims = classifyText("echo `gen.sh` > lib/a.ts");
    expect(claims.opaque).toBe("echo");
  });

  it("a quoted $( word makes the command opaque by substitution too", () => {
    const claims = classifyText("echo \"$(gen.sh)\" > lib/a.ts");
    expect(claims.opaque).toBe("echo");
  });
});

describe("classifyText: git", () => {
  it("a git rm in place names its target", () => {
    const claims = classifyText("git rm lib/a.ts");
    expect(claims.writes.flatMap(({ tokens }) => tokens)).toContain("lib/a.ts");
  });

  it("a git rm that moved elsewhere is opaque", () => {
    const claims = classifyText("git -C elsewhere rm lib/a.ts");
    expect(claims.opaque).toBe("git");
  });

  it("a git subcommand that leaves the tree alone is inert", () => {
    const claims = classifyText("git status");
    expect(claims).toMatchObject({ opaque: undefined, writes: [] });
  });
});

describe("opaqueProgram", () => {
  it("names the program a package manager or fixer runs", () => {
    expect(opaqueProgram("npm run fix")).toBe("npm");
    expect(opaqueProgram("eslint --fix")).toBe("eslint");
  });

  it("is undefined for prose and for path-led words", () => {
    expect(opaqueProgram("please review lib/a.ts now")).toBeUndefined();
    expect(opaqueProgram("./scripts/gen.sh runs")).toBeUndefined();
    expect(opaqueProgram("SECRET=hunter2 /opt/bin/builder --token abc123")).toBeUndefined();
  });
});

describe("classifyText: the remaining verdicts", () => {
  it("a stash show and a remote -v read without touching the tree", () => {
    expect(classifyText("git stash show").writes).toEqual([]);
    expect(classifyText("git stash list").writes).toEqual([]);
    expect(classifyText("git remote --verbose").writes).toEqual([]);
  });

  it("a copy with no file arguments names nothing", () => {
    expect(classifyText("cp -t staging").writes).toEqual([]);
  });

  it("dot and dot-dot sources name the destination alone", () => {
    expect(classifyText("cp .. staging").writes.flatMap(({ tokens }) => tokens)).toEqual(["staging"]);
  });

  it("a quoted substitution in an assignment-only command is opaque by substitution", () => {
    expect(classifyText('X="$(gen)"').opaque).toBe("(substitution)");
  });

  it("a redirect on an assignment-only command names the redirect target", () => {
    expect(classifyText("X=1 > lib/a.ts").writes.flatMap(({ tokens }) => tokens)).toEqual(["lib/a.ts"]);
  });

  it("a copy with flags alone names nothing", () => {
    expect(classifyText("cp -r").writes).toEqual([]);
  });

  it("a dot source of a move names the destination and the source itself", () => {
    expect(classifyText("mv . staging").writes.flatMap(({ tokens }) => tokens)).toEqual([".", "staging"]);
  });

  it("a move with no file arguments is opaque and names nothing", () => {
    const claims = classifyText("mv -f");
    expect(claims.opaque).toBe("mv");
    expect(claims.writes).toEqual([]);
  });

  it("opaqueProgram has no word to name on a line of assignments alone", () => {
    expect(opaqueProgram("X=1")).toBeUndefined();
  });

  it("opaqueProgram names the opaque runners it knows", () => {
    expect(opaqueProgram("docker build .")).toBe("docker");
    expect(opaqueProgram("python3 -m black .")).toBeDefined();
    expect(opaqueProgram("make all")).toBe("make");
  });
});

describe("classifyText: destinations decided by flags", () => {
  it("a -t copy names nothing by destination", () => {
    expect(classifyText("cp -t staging lib/a.ts").writes).toEqual([]);
  });

  it("opaqueProgram has no word when the text is empty", () => {
    expect(opaqueProgram("")).toBeUndefined();
  });
});

describe("classifyText: a move with no arguments at all", () => {
  it("is opaque and names nothing", () => {
    const claims = classifyText("mv");
    expect(claims.opaque).toBe("mv");
    expect(claims.writes).toEqual([]);
  });
});

describe("classifyText: a git command with only options", () => {
  it("is opaque, and names nothing", () => {
    const claims = classifyText("git -C");
    expect(claims.opaque).toBe("git");
    expect(claims.writes).toEqual([]);
  });
});
