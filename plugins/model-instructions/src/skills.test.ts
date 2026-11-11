import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { frontmatter, loadSkills } from "./skills.js";

// Ported from the skill discovery cases of plugins/dir-skills/server.setup.test.ts (tag dir-skills/v0.2.8), against a fixture root.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "model-instructions-skills-")));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function skill(entry: string, body: string): string {
  const dir = path.join(root, entry);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), body);
  return dir;
}

describe("frontmatter", () => {
  it("reads a single-line name and description, with or without quotes", () => {
    const file = path.join(skill("fm-quoted", ""), "SKILL.md");
    writeFileSync(file, '---\nname: "quoted-name"\ndescription: \'a quoted description\'\n---\nbody');
    expect(frontmatter(file)).toEqual({
      name: "quoted-name",
      description: "a quoted description",
    });
    writeFileSync(file, "---\r\nname: plain\r\ndescription:   spaced   \r\n---\r\nbody");
    expect(frontmatter(file)).toEqual({ name: "plain", description: "spaced" });
  });

  it("returns no name and an empty description without frontmatter", () => {
    const file = path.join(skill("fm-none", "no frontmatter here"), "SKILL.md");
    expect(frontmatter(file)).toEqual({ name: null, description: "" });
  });

  it("does not read YAML block values", () => {
    const file = path.join(skill("fm-block", ""), "SKILL.md");
    writeFileSync(file, "---\nname: blocky\ndescription: >\n  folded text\n---\n");
    expect(frontmatter(file)).toEqual({ name: "blocky", description: ">" });
  });
});

describe("loadSkills", () => {
  it("skips unreadable and file entries, naming the rest by frontmatter or directory", () => {
    const base = path.join(root, "load");
    mkdirSync(base);
    const make = (entry: string, make: (p: string) => void) => make(path.join(base, entry));
    make("a-named", (p) => {
      mkdirSync(p);
      writeFileSync(path.join(p, "SKILL.md"), "---\nname: renamed\ndescription: Does a thing\n---\nbody");
    });
    make("b-no-skill", (p) => mkdirSync(p));
    make("c-unnamed", (p) => {
      mkdirSync(p);
      writeFileSync(path.join(p, "SKILL.md"), "---\ndescription: temp fixture without a name\n---\nbody");
    });
    make("d-plain", (p) => {
      mkdirSync(p);
      writeFileSync(path.join(p, "SKILL.md"), "no frontmatter here");
    });
    make("e-file.txt", (p) => writeFileSync(p, "not a skill dir"));
    make("f-dangling", (p) => symlinkSync(path.join(base, "missing-target"), p));

    expect(loadSkills(base)).toEqual([
      { name: "renamed", description: "Does a thing", dir: path.join(base, "a-named") },
      { name: "c-unnamed", description: "temp fixture without a name", dir: path.join(base, "c-unnamed") },
      { name: "d-plain", description: "", dir: path.join(base, "d-plain") },
    ]);
  });

  it("throws when the root does not exist", () => {
    expect(() => loadSkills(path.join(root, "nope"))).toThrow(/ENOENT/);
  });

  it("returns nothing for an empty root", () => {
    const empty = path.join(root, "empty");
    mkdirSync(empty);
    expect(loadSkills(empty)).toEqual([]);
  });
});
