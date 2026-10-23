import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The script is a top-level `writeChecksums() + print`. The stub below keeps
// that run off the repo's real hooks/CHECKSUMS; the subprocess test exercises
// the real pair end to end against synthetic fixtures.
const { writeChecksums } = vi.hoisted(() => ({ writeChecksums: vi.fn() }));
vi.mock("../src/sync.mjs", () => ({ writeChecksums, SOURCE_DIR: "/fixture/hooks" }));

describe("checksums script", () => {
  it("prints the manifest path plus the exact text writeChecksums returned", async () => {
    const text = "sha256-abc  guard-bash.sh\n";
    writeChecksums.mockReturnValueOnce(text);
    const chunks = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await import("./checksums.mjs");
    } finally {
      spy.mockRestore();
    }
    expect(writeChecksums).toHaveBeenCalledWith();
    expect(chunks).toEqual([`wrote /fixture/hooks/CHECKSUMS\n${text}`]);
  });

  it("regenerates hooks/CHECKSUMS from the plugin's real sync code", () => {
    // Stand-in plugin tree: same two modules, synthetic hook scripts.
    const root = mkdtempSync(path.join(tmpdir(), "checksums-script-"));
    try {
      for (const dir of ["src", "scripts", "hooks"]) mkdirSync(path.join(root, dir));
      copyFileSync(path.join(HERE, "../src/sync.mjs"), path.join(root, "src/sync.mjs"));
      copyFileSync(path.join(HERE, "../src/wire.mjs"), path.join(root, "src/wire.mjs"));
      copyFileSync(path.join(HERE, "checksums.mjs"), path.join(root, "scripts/checksums.mjs"));
      writeFileSync(path.join(root, "hooks/guard-bash.sh"), "#!/bin/sh\necho synthetic guard\n");
      writeFileSync(path.join(root, "hooks/session-reset.sh"), "#!/bin/sh\nexit 0\n");
      writeFileSync(path.join(root, "hooks/notes.txt"), "not a script, must not be hashed\n");

      const out = execFileSync(process.execPath, [path.join(root, "scripts/checksums.mjs")], { encoding: "utf8" });

      // macOS resolves /var/... to /private/var/... inside the child.
      const hooks = path.join(realpathSync(root), "hooks");
      const digest = (name) =>
        createHash("sha256").update(readFileSync(path.join(root, "hooks", name))).digest("hex");
      const expected =
        `${digest("guard-bash.sh")}  guard-bash.sh\n${digest("session-reset.sh")}  session-reset.sh\n`;
      expect(readFileSync(path.join(root, "hooks/CHECKSUMS"), "utf8")).toBe(expected);
      expect(out).toBe(`wrote ${hooks}/CHECKSUMS\n${expected}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
