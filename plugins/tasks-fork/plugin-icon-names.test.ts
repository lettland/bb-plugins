import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_BUILTIN_ICON_NAMES } from "./host-icon-names";

const pluginDir = fileURLToPath(new URL(".", import.meta.url));
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

const ICON_PROP_PATTERNS = [
  /<Icon\b[^>]*?\sname=(\{[^}]*\}|"[^"]*")/gs,
  /\bicon(?:=|:\s)\s*(\{[^}]*\}|"[^"]*")/g,
  /\bfallback=(\{[^}]*\}|"[^"]*")/g,
];

function iconNamesIn(source: string): string[] {
  const names: string[] = [];
  for (const pattern of ICON_PROP_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      for (const literal of match[1]!.matchAll(/"([^"]*)"/g)) {
        const name = literal[1]!;
        if (/^[A-Z][A-Za-z0-9]*$/.test(name)) names.push(name);
      }
    }
  }
  return names;
}

describe("tasks plugin icon names", () => {
  it("only references icons the host's built-in registry can resolve", () => {
    const unregistered = new Map<string, string[]>();
    let checked = 0;
    for (const file of sourceFiles(pluginDir)) {
      for (const name of iconNamesIn(readFileSync(file, "utf8"))) {
        checked += 1;
        if (HOST_BUILTIN_ICON_NAMES.has(name)) continue;
        const files = unregistered.get(name) ?? [];
        files.push(file.slice(pluginDir.length));
        unregistered.set(name, files);
      }
    }

    expect(checked).toBeGreaterThan(30);
    expect(Object.fromEntries(unregistered)).toEqual({});
  });

  it("flags a name the host registry does not know", () => {
    expect(iconNamesIn('<Icon name="NoSuchHostIcon" />')).toEqual([
      "NoSuchHostIcon",
    ]);
    expect(HOST_BUILTIN_ICON_NAMES.has("NoSuchHostIcon")).toBe(false);
    expect(HOST_BUILTIN_ICON_NAMES.has("ListTodo")).toBe(true);
  });
});
