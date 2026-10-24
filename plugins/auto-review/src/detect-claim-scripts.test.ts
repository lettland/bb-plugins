import { describe, expect, it } from "vitest";
import {
  awkReadsOnly,
  bbReads,
  flagsOf,
  ghReads,
  inPlaceSuffix,
  isCheckRun,
  perlCodeIsPure,
  ripwireReads,
  sedScriptIsPure,
  sedScripts,
} from "./detect-claim-scripts.js";

const word = (text: string) => ({ text, quoted: false });

describe("sedScriptIsPure", () => {
  it("accepts substitute, transliterate and plain commands", () => {
    expect(sedScriptIsPure("s/a/b/g")).toBe(true);
    expect(sedScriptIsPure("y/ab/cd/")).toBe(true);
    expect(sedScriptIsPure("p;d;n")).toBe(true);
    expect(sedScriptIsPure("2{/foo/Ip;}")).toBe(true);
  });

  it("rejects commands that write, branch or are not understood", () => {
    expect(sedScriptIsPure("s/a/b/w out.txt")).toBe(false);
    expect(sedScriptIsPure("r file")).toBe(false);
    expect(sedScriptIsPure("z")).toBe(false);
  });

  it("reads a custom-delimiter address with its flags, and rejects an unterminated one", () => {
    expect(sedScriptIsPure("\\#a/b#Id")).toBe(true);
    expect(sedScriptIsPure("/a/b")).toBe(false);
    expect(sedScriptIsPure("s/a/b")).toBe(false);
  });

  it("an escaped delimiter does not end the pattern", () => {
    expect(sedScriptIsPure("s/a\\/b/c/")).toBe(true);
  });

  it("lets a, i and c text through only in place", () => {
    expect(sedScriptIsPure("a text", true)).toBe(true);
    expect(sedScriptIsPure("a te\\xt", true)).toBe(true);
    expect(sedScriptIsPure("a text")).toBe(false);
  });
});

describe("sedScripts", () => {
  it("reads -e scripts, --expression= words and the first plain argument", () => {
    expect(sedScripts([word("-e"), word("s/a/b/"), word("-e")])).toEqual(["s/a/b/", ""]);
    expect(sedScripts([word("--expression=s/a/b/"), word("--expression=")])).toEqual(["s/a/b/", ""]);
    expect(sedScripts([word("s/x/y/"), word("other")])).toEqual(["s/x/y/"]);
  });

  it("is null when a script file is read", () => {
    expect(sedScripts([word("-f"), word("script.sed")])).toBeNull();
    expect(sedScripts([word("--file=script.sed")])).toBeNull();
  });
});

describe("awkReadsOnly", () => {
  it("is true for a print program with value options", () => {
    expect(awkReadsOnly([word("-F"), word(","), word("-v"), word("x=1"), word("{print $1}")])).toBe(true);
  });

  it("is false for a program that writes, and for code loaded from elsewhere", () => {
    expect(awkReadsOnly([word('{print $1 > "out.txt"}')])).toBe(false);
    expect(awkReadsOnly([word("-f"), word("prog.awk")])).toBe(false);
    expect(awkReadsOnly([word("-E"), word("prog")])).toBe(false);
  });
});

describe("perlCodeIsPure", () => {
  it("is true for inline code that only edits", () => {
    expect(perlCodeIsPure([word("-pi.bak"), word("-e"), word("s/a/b/ while <>")])).toBe(true);
  });

  it("is false without -e, with a module load, or when the code writes", () => {
    expect(perlCodeIsPure([word("-p"), word("script.pl")])).toBe(false);
    expect(perlCodeIsPure([word("-pi"), word("-e"), word("s/a/b/"), word("-MData::Dumper")])).toBe(false);
    expect(perlCodeIsPure([word("-pi"), word("-e"), word("unlink 'lib/a.ts'")])).toBe(false);
  });
});

describe("isCheckRun", () => {
  it("accepts test runners, a no-emit tsc, and go and cargo checks", () => {
    expect(isCheckRun({ name: "vitest", args: [word("run")] } as never)).toBe(true);
    expect(isCheckRun({ name: "tsc", args: [word("--noEmit")] } as never)).toBe(true);
    expect(isCheckRun({ name: "go", args: [word("test"), word("./...")] } as never)).toBe(true);
    expect(isCheckRun({ name: "go", args: [word("vet")] } as never)).toBe(true);
    expect(isCheckRun({ name: "cargo", args: [word("check")] } as never)).toBe(true);
    expect(isCheckRun({ name: "cargo", args: [word("clippy")] } as never)).toBe(true);
    expect(isCheckRun({ name: "cargo", args: [word("nextest"), word("run")] } as never)).toBe(true);
  });

  it("rejects fixers, emitting flags and builds", () => {
    expect(isCheckRun({ name: "vitest", args: [word("--update")] } as never)).toBe(false);
    expect(isCheckRun({ name: "jest", args: [word("-o")] } as never)).toBe(true);
    expect(isCheckRun({ name: "go", args: [word("build")] } as never)).toBe(false);
    expect(isCheckRun({ name: "tsc", args: [word("--noEmit"), word("false")] } as never)).toBe(false);
    expect(isCheckRun({ name: "tsc", args: [word("--noEmit=false")] } as never)).toBe(false);
  });

  it("accepts test, lint and typecheck package scripts", () => {
    expect(isCheckRun({ name: "pnpm", args: [word("run"), word("lint")] } as never)).toBe(true);
    expect(isCheckRun({ name: "npm", args: [word("run-script"), word("test:unit")] } as never)).toBe(true);
    expect(isCheckRun({ name: "yarn", args: [word("type-check")] } as never)).toBe(true);
    expect(isCheckRun({ name: "pnpm", args: [word("build")] } as never)).toBe(false);
  });
});

describe("inPlaceSuffix", () => {
  it("reads the suffix of a sed and a perl in-place flag", () => {
    expect(inPlaceSuffix("sed", [word("-i.bak"), word("s/a/b/")])).toBe(".bak");
    expect(inPlaceSuffix("perl", [word("-pi.bak"), word("-e"), word("s/a/b/")])).toBe(".bak");
    expect(inPlaceSuffix("sed", [word("--in-place=.orig")])).toBe(".orig");
    expect(inPlaceSuffix("sed", [word("-e"), word("s/a/b/")])).toBe("");
  });
});

describe("ripwireReads", () => {
  it("is true for a read mode with shape options", () => {
    expect(ripwireReads({ args: [word("--for=tests"), word("--json")] } as never)).toBe(true);
  });

  it("is false for a non-read mode and for an unknown option", () => {
    expect(ripwireReads({ args: [word("--json"), word("--task"), word("x")] } as never)).toBe(false);
    expect(ripwireReads({ args: [word("--wat")] } as never)).toBe(false);
  });
});

describe("ghReads and bbReads", () => {
  it("gh reads views and lists of its topics", () => {
    expect(ghReads({ args: [word("pr"), word("view")] } as never)).toBe(true);
    expect(ghReads({ args: [word("run"), word("list")] } as never)).toBe(true);
    expect(ghReads({ args: [word("status")] } as never)).toBe(false);
    expect(ghReads({ args: [word("pr"), word("edit")] } as never)).toBe(false);
    expect(ghReads({ args: [] } as never)).toBe(false);
    expect(ghReads({ args: [word("pr")] } as never)).toBe(false);
  });

  it("bb reads its top-level status and read subcommands", () => {
    expect(bbReads({ args: [word("status")] } as never)).toBe(true);
    expect(bbReads({ args: [word("thread"), word("show"), word("thr")] } as never)).toBe(true);
    expect(bbReads({ args: [] } as never)).toBe(false);
    expect(bbReads({ args: [word("auto-review"), word("reset")] } as never)).toBe(false);
  });
});

describe("flagsOf", () => {
  it("is the words of the arguments", () => {
    expect(flagsOf([word("-a"), word("b")])).toEqual(["-a", "b"]);
  });
});

describe("awkReadsOnly: options that are neither values nor code", () => {
  it("skips an unknown option and keeps reading the program", () => {
    expect(awkReadsOnly([word("-q"), word("-v"), word("x=1"), word("{print $1}")])).toBe(true);
  });

  it("bb and gh: the remaining read shapes", () => {
    expect(bbReads({ args: [word("guide")] } as never)).toBe(true);
    expect(bbReads({ args: [word("auto-review"), word("status")] } as never)).toBe(true);
    expect(ghReads({ args: [word("issue"), word("view"), word("1")] } as never)).toBe(true);
  });
});
