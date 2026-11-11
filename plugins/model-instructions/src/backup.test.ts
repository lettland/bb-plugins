import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupRules } from "./backup.js";

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "model-instructions-backup-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const at = () => new Date("2026-11-11T12:34:56.789Z");
const dirIn = () => path.join(base, "backups");

describe("backupRules", () => {
  it("writes the text unchanged to a named file, mode 0600, in a new folder of mode 0700", () => {
    const text = '[{"instructions": "  keep   this  "}]\n';
    const file = backupRules(dirIn(), text, at, () => "ab12");
    expect(file).toBe(path.join(dirIn(), "rules-2026-11-11T12-34-56-789-ab12.txt"));
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirIn()).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirIn())).toEqual(["rules-2026-11-11T12-34-56-789-ab12.txt"]);
  });

  it("names the file from the real clock and four random hex digits by default", () => {
    const file = backupRules(dirIn(), "x");
    expect(path.basename(file)).toMatch(/^rules-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{4}\.txt$/);
  });

  it("returns the file that already holds the same text, and writes nothing", () => {
    const first = backupRules(dirIn(), "same", at, () => "0001");
    expect(backupRules(dirIn(), "same", at, () => "0002")).toBe(first);
    expect(readdirSync(dirIn())).toHaveLength(1);
  });

  it("writes a new file for a text that differs, and keeps the old one", () => {
    const first = backupRules(dirIn(), "one", at, () => "0001");
    const second = backupRules(dirIn(), "two", at, () => "0002");
    expect(second).not.toBe(first);
    expect(readFileSync(first, "utf8")).toBe("one");
    expect(readFileSync(second, "utf8")).toBe("two");
  });

  it("finds an identical file of any name in the folder", () => {
    mkdirSync(dirIn(), { recursive: true });
    writeFileSync(path.join(dirIn(), "mine.json"), "kept");
    expect(backupRules(dirIn(), "kept")).toBe(path.join(dirIn(), "mine.json"));
  });

  it("counts a file that cannot be read as different, not as a failure", () => {
    mkdirSync(path.join(dirIn(), "a-folder"), { recursive: true });
    symlinkSync(path.join(base, "missing"), path.join(dirIn(), "dangling"));
    const file = backupRules(dirIn(), "text", at, () => "0001");
    expect(readFileSync(file, "utf8")).toBe("text");
  });

  it("throws, and replaces nothing, when a file of that name holds other text", () => {
    const first = backupRules(dirIn(), "one", at, () => "0001");
    expect(() => backupRules(dirIn(), "two", at, () => "0001")).toThrow(`${first} already exists`);
    expect(readFileSync(first, "utf8")).toBe("one");
    expect(readdirSync(dirIn())).toEqual([path.basename(first)]);
  });

  it("throws when the folder cannot be made or written", () => {
    writeFileSync(dirIn(), "a file where the folder should be");
    expect(() => backupRules(dirIn(), "x")).toThrow();
  });

  it("throws when the folder cannot be written to", () => {
    mkdirSync(dirIn(), { recursive: true });
    chmodSync(dirIn(), 0o500);
    try {
      if (process.getuid?.() === 0) return;
      expect(() => backupRules(dirIn(), "x")).toThrow(/EACCES/);
    } finally {
      chmodSync(dirIn(), 0o700);
    }
  });
});
