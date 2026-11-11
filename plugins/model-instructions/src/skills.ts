import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface SkillEntry {
  name: string;
  description: string;
  dir: string;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

/** The single-line `name` and `description` of a SKILL.md frontmatter. YAML block values are not read. */
export function frontmatter(skillFile: string): { name: string | null; description: string } {
  const text = readFileSync(skillFile, "utf8");
  const found = { name: null as string | null, description: "" };
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return found;
  for (const line of match[1].split(/\r?\n/)) {
    const name = /^name:\s*(.+?)\s*$/.exec(line);
    if (name) found.name = unquote(name[1]);
    const description = /^description:\s*(.+?)\s*$/.exec(line);
    if (description) found.description = unquote(description[1]);
  }
  return found;
}

/** Every skill directory under `skillsRoot` that has a readable SKILL.md, sorted by directory name. */
export function loadSkills(skillsRoot: string): SkillEntry[] {
  const skills: SkillEntry[] = [];
  for (const entry of readdirSync(skillsRoot).sort()) {
    const dir = path.join(skillsRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const skillFile = path.join(dir, "SKILL.md");
    let name: string;
    let description: string;
    try {
      const meta = frontmatter(skillFile);
      name = meta.name ?? entry;
      description = meta.description;
    } catch {
      continue;
    }
    skills.push({ name, description, dir });
  }
  return skills;
}
