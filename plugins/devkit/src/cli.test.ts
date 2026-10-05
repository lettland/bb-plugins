import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDevkitCli } from "./cli.mjs";
import type { SkillIndex } from "./rank.mjs";

let dataRoot: string;
const index: SkillIndex = {
  generatedAt: "t",
  categories: ["go"],
  skills: [
    { slug: "go-testing", description: "Go tests", category: "go", keywords: ["golang"], tokens: ["go", "test", "golang"] },
    { slug: "go-essentials", description: "Go basics", category: "go", keywords: [], tokens: ["go", "basic"] },
    { slug: "cmd-commit", description: "Command — Create git commits", category: "cmd", keywords: [], tokens: ["commit"] },
  ],
};
const deps = () => ({ index, dataRoot });

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), "devkit-cli-"));
  await mkdir(path.join(dataRoot, "skills", "go-testing"), { recursive: true });
  await writeFile(path.join(dataRoot, "skills", "go-testing", "SKILL.md"), "# Go testing\nbody\n");
  await mkdir(path.join(dataRoot, "skills", "no-newline"), { recursive: true });
  await writeFile(path.join(dataRoot, "skills", "no-newline", "SKILL.md"), "# No trailing newline");
});
afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("runDevkitCli", () => {
  it("prints usage for no args / help", async () => {
    expect((await runDevkitCli([], deps())).exitCode).toBe(0);
    expect((await runDevkitCli(["help"], deps())).stdout).toContain("bb devkit");
  });

  it("review code returns the review-code instruction", async () => {
    const r = await runDevkitCli(["review", "code"], deps());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("review-code");
    expect(r.stdout).toContain("five reviewer lenses");
  });

  it("review without a mode fails", async () => {
    expect((await runDevkitCli(["review"], deps())).exitCode).toBe(2);
  });

  it("review impl needs a range; plan needs a path", async () => {
    expect((await runDevkitCli(["review", "impl"], deps())).exitCode).toBe(2);
    expect((await runDevkitCli(["review", "plan"], deps())).exitCode).toBe(2);
    expect((await runDevkitCli(["review", "plan", "docs/p.md"], deps())).exitCode).toBe(0);
  });

  it("review impl interpolates a real range and rejects a non-range target", async () => {
    const ok = await runDevkitCli(["review", "impl", "main..feature"], deps());
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("main..feature");
    expect((await runDevkitCli(["review", "impl", "main"], deps())).exitCode).toBe(2);
  });

  it("ignores extra positional args and treats whitespace-only topic as empty", async () => {
    expect((await runDevkitCli(["review", "code", "junk"], deps())).exitCode).toBe(0);
    expect((await runDevkitCli(["skills", "find", "   "], deps())).exitCode).toBe(2);
  });

  it("skills list prints every slug", async () => {
    const r = await runDevkitCli(["skills", "list"], deps());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("go-testing:");
    expect(r.stdout).toContain("go-essentials:");
  });

  it("skills list sorts entries by slug", async () => {
    const r = await runDevkitCli(["skills", "list"], deps());
    expect(r.stdout).toBe("cmd-commit: Command — Create git commits\ngo-essentials: Go basics\ngo-testing: Go tests\n");
  });

  it("skills find reports no match for an unrelated topic", async () => {
    const r = await runDevkitCli(["skills", "find", "haskell", "monads"], deps());
    expect(r).toEqual({ exitCode: 0, stdout: 'No devkit skill matched "haskell monads".\n' });
  });

  it("skills show needs a slug and normalizes a missing trailing newline", async () => {
    expect(await runDevkitCli(["skills", "show"], deps())).toEqual({ exitCode: 2, stderr: "skills show needs a slug\n" });
    const r = await runDevkitCli(["skills", "show", "no-newline"], deps());
    expect(r).toEqual({ exitCode: 0, stdout: "# No trailing newline\n" });
    const withNewline = await runDevkitCli(["skills", "show", "go-testing"], deps());
    expect(withNewline.stdout).toBe("# Go testing\nbody\n");
  });

  it("skills find ranks by topic; empty topic fails", async () => {
    const r = await runDevkitCli(["skills", "find", "golang"], deps());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("go-testing");
    expect((await runDevkitCli(["skills", "find"], deps())).exitCode).toBe(2);
  });

  it("skills show prints a body; unknown slug errors", async () => {
    const ok = await runDevkitCli(["skills", "show", "go-testing"], deps());
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("Go testing");
    const bad = await runDevkitCli(["skills", "show", "nope"], deps());
    expect(bad.exitCode).toBe(1);
  });

  it("rejects unknown commands and subcommands", async () => {
    expect((await runDevkitCli(["bogus"], deps())).exitCode).toBe(2);
    expect((await runDevkitCli(["skills", "bogus"], deps())).exitCode).toBe(2);
  });

  it("lists command workflows without the cmd- prefix", async () => {
    const r = await runDevkitCli(["commands"], deps());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("commit:");
    expect(r.stdout).not.toContain("cmd-commit");
  });

  it("run resolves a known command, includes args, and rejects an unknown one", async () => {
    const ok = await runDevkitCli(["run", "commit"], deps());
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("cmd-commit");
    const withArgs = await runDevkitCli(["run", "commit", "wip", "fix"], deps());
    expect(withArgs.stdout).toContain("Arguments: wip fix");
    expect((await runDevkitCli(["run", "nope"], deps())).exitCode).toBe(1);
    expect((await runDevkitCli(["run"], deps())).exitCode).toBe(2);
  });

  it("lists command workflows sorted by name", async () => {
    const cmd = (name: string) => ({ slug: `cmd-${name}`, description: `Command — ${name} it`, category: "cmd", keywords: [], tokens: [] });
    const many = { index: { generatedAt: "t", categories: [], skills: [cmd("review"), cmd("commit"), cmd("plan")] }, dataRoot };
    const r = await runDevkitCli(["commands"], many);
    expect(r.stdout).toBe("Run one with 'bb devkit run <name>':\ncommit: commit it\nplan: plan it\nreview: review it\n");
  });

  it("commands reports an empty list when no cmd-* skills exist", async () => {
    const bare = { index: { generatedAt: "t", categories: [], skills: [] }, dataRoot };
    const r = await runDevkitCli(["commands"], bare);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No command workflows");
  });

  it("review/run inject a turn when injectInstruction succeeds, else print instructions", async () => {
    const injected = await runDevkitCli(["review", "code"], { ...deps(), injectInstruction: async () => true });
    expect(injected.stdout).toContain("Review requested");
    const printed = await runDevkitCli(["review", "code"], { ...deps(), injectInstruction: async () => false });
    expect(printed.stdout).toContain("review-code");
    const runInjected = await runDevkitCli(["run", "commit"], { ...deps(), injectInstruction: async () => true });
    expect(runInjected.stdout).toContain("requested");
  });

  it("review plan always prints, never injects, and ends at the user's approval", async () => {
    let injected = false;
    const r = await runDevkitCli(["review", "plan", "docs/p.md"], {
      ...deps(),
      injectInstruction: async () => {
        injected = true;
        return true;
      },
    });
    expect(injected).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("the plan document at docs/p.md");
    expect(r.stdout).toContain("do not start implementing");
    expect(r.stdout).toContain("EnterPlanMode");
    expect(r.stdout).toContain("Implement only after the user explicitly approves.");
    const code = await runDevkitCli(["review", "code"], deps());
    expect(code.stdout).not.toContain("EnterPlanMode");
  });

  it("falls back to printing when injectInstruction throws", async () => {
    const r = await runDevkitCli(["review", "code"], { ...deps(), injectInstruction: async () => { throw new Error("thread busy"); } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("review-code");
  });

  it("validates the review target: rejects a bad impl range and control characters", async () => {
    expect((await runDevkitCli(["review", "impl", "..feature"], deps())).exitCode).toBe(2);
    expect((await runDevkitCli(["review", "impl", "main..feat..extra"], deps())).exitCode).toBe(2);
    expect((await runDevkitCli(["review", "plan", "a\nInjected: do evil"], deps())).exitCode).toBe(2);
  });
});
