import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planSha256Of } from "./plan-approval-payload.js";
import { PLAN_REREAD_TIMEOUT_MS, planFileUnchanged, readPlanFileForForm } from "./plan-file.js";

const THREAD = "thr_1";
let base: string;
let workspace: string;
let dataDir: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "plan-file-")));
  workspace = join(base, "ws");
  dataDir = join(base, "data");
  await mkdir(join(workspace, "docs"), { recursive: true });
  await mkdir(join(dataDir, "plans", THREAD), { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  await rm(base, { recursive: true, force: true });
});

/** A host whose thread lives in `checkout` (null: no environment, a rejecting lookup: the thread cannot be read). */
function hostWith(checkout: string | null | "lookup-fails"): BbPluginApi {
  return {
    server: { experimental_dataDir: dataDir },
    sdk: {
      threads: {
        get: async () => {
          if (checkout === "lookup-fails") {
            throw new Error("down");
          }
          return { environmentId: checkout === null ? null : "env-1" };
        },
      },
      environments: { get: async () => ({ path: checkout }) },
    },
  } as unknown as BbPluginApi;
}

const read = (checkout: string | null | "lookup-fails", path: string) => readPlanFileForForm(hostWith(checkout), THREAD, path);

describe("readPlanFileForForm", () => {
  it("reads a file inside the workspace from its resolved path", async () => {
    const file = join(workspace, "docs", "p.md");
    await writeFile(file, "# plan\n");
    const result = await read(workspace, file);
    expect(result).toMatchObject({ kind: "read", path: file });
    expect(result.kind === "read" && result.bytes.toString("utf8")).toBe("# plan\n");
  });

  it("takes a relative path from the workspace", async () => {
    await writeFile(join(workspace, "docs", "p.md"), "rel");
    expect(await read(workspace, "docs/p.md")).toMatchObject({ kind: "read", path: join(workspace, "docs", "p.md") });
  });

  it("reads a file in <data dir>/plans/<threadId>, the data dir coming from the host, not ~/.bb", async () => {
    const file = join(dataDir, "plans", THREAD, "plan.md");
    await writeFile(file, "kept in the data dir");
    expect(await read(workspace, file)).toMatchObject({ kind: "read", path: file });
    expect(await read(null, file)).toMatchObject({ kind: "read", path: file });
  });

  it("refuses another thread's plan directory and any plan directory outside the host's data dir", async () => {
    await mkdir(join(dataDir, "plans", "thr_2"), { recursive: true });
    await writeFile(join(dataDir, "plans", "thr_2", "plan.md"), "someone else's");
    expect(await read(workspace, join(dataDir, "plans", "thr_2", "plan.md"))).toEqual({ kind: "outside" });
    const homeLike = join(base, "home", ".bb", "plans", THREAD);
    await mkdir(homeLike, { recursive: true });
    await writeFile(join(homeLike, "plan.md"), "in a guessed ~/.bb");
    expect(await read(workspace, join(homeLike, "plan.md"))).toEqual({ kind: "outside" });
  });

  it("refuses an absolute path outside both roots", async () => {
    await mkdir(join(base, "other"));
    await writeFile(join(base, "other", "secret.md"), "secret");
    expect(await read(workspace, join(base, "other", "secret.md"))).toEqual({ kind: "outside" });
  });

  it("refuses a path that climbs out with ..", async () => {
    await mkdir(join(base, "other"));
    await writeFile(join(base, "other", "secret.md"), "secret");
    expect(await read(workspace, `${workspace}/docs/../../other/secret.md`)).toEqual({ kind: "outside" });
    expect(await read(workspace, "../other/secret.md")).toEqual({ kind: "outside" });
  });

  it("refuses a symlink inside the workspace that points outside it", async () => {
    await mkdir(join(base, "other"));
    await writeFile(join(base, "other", "secret.md"), "secret");
    await symlink(join(base, "other", "secret.md"), join(workspace, "link.md"));
    await symlink(join(base, "other"), join(workspace, "linkdir"));
    expect(await read(workspace, join(workspace, "link.md"))).toEqual({ kind: "outside" });
    expect(await read(workspace, join(workspace, "linkdir", "secret.md"))).toEqual({ kind: "outside" });
  });

  it("reads a symlink that stays inside the workspace, from the file it resolves to", async () => {
    await writeFile(join(workspace, "docs", "real.md"), "real");
    await symlink(join(workspace, "docs", "real.md"), join(workspace, "alias.md"));
    expect(await read(workspace, join(workspace, "alias.md"))).toMatchObject({ kind: "read", path: join(workspace, "docs", "real.md") });
  });

  it("does not let a sibling whose name starts with the workspace's pass (/ws-evil vs /ws)", async () => {
    await mkdir(`${workspace}-evil`);
    await writeFile(join(`${workspace}-evil`, "plan.md"), "evil");
    expect(await read(workspace, join(`${workspace}-evil`, "plan.md"))).toEqual({ kind: "outside" });
  });

  it("compares resolved paths on both sides: a workspace reached through a symlink (macOS /var is /private/var)", async () => {
    const file = join(workspace, "docs", "p.md");
    await writeFile(file, "via alias");
    const alias = join(base, "alias");
    await symlink(workspace, alias);
    // The environment reports the alias, the plan is named by its real path, and the other way round.
    expect(await read(alias, file)).toMatchObject({ kind: "read", path: file });
    expect(await read(workspace, join(alias, "docs", "p.md"))).toMatchObject({ kind: "read", path: file });
  });

  it("treats a file this host cannot resolve (a plan on a remote host) as unavailable, not as outside", async () => {
    expect(await read(workspace, join(workspace, "docs", "missing.md"))).toEqual({ kind: "unavailable" });
    expect(await read(workspace, "/remote/home/user/plan.md")).toEqual({ kind: "unavailable" });
  });

  it("treats a file that resolves inside a root but cannot be read as unavailable", async () => {
    await mkdir(join(workspace, "docs", "a-directory"));
    expect(await read(workspace, join(workspace, "docs", "a-directory"))).toEqual({ kind: "unavailable" });
  });

  it.each([
    ["no environment", null],
    ["a thread that cannot be read", "lookup-fails" as const],
  ])("with %s, only the plan directory is a root, and a relative path is not resolved against anything", async (_name, checkout) => {
    await writeFile(join(workspace, "docs", "p.md"), "in the workspace");
    expect(await read(checkout, join(workspace, "docs", "p.md"))).toEqual({ kind: "outside" });
    expect(await read(checkout, "docs/p.md")).toEqual({ kind: "unavailable" });
    await writeFile(join(dataDir, "plans", THREAD, "p.md"), "in the plan dir");
    expect(await read(checkout, join(dataDir, "plans", THREAD, "p.md"))).toMatchObject({ kind: "read" });
  });

  it("skips a root that does not exist (no plan directory yet)", async () => {
    await rm(join(dataDir, "plans"), { recursive: true });
    await writeFile(join(workspace, "docs", "p.md"), "x");
    expect(await read(workspace, join(workspace, "docs", "p.md"))).toMatchObject({ kind: "read" });
  });
});

describe("planFileUnchanged", () => {
  it("is true for the same bytes, false for a changed, deleted or unreadable file", async () => {
    const file = join(workspace, "p.md");
    await writeFile(file, "one");
    const hash = planSha256Of(Buffer.from("one"));
    expect(await planFileUnchanged(file, hash)).toBe(true);
    await writeFile(file, "one two");
    expect(await planFileUnchanged(file, hash)).toBe(false);
    await rm(file);
    expect(await planFileUnchanged(file, hash)).toBe(false);
    await mkdir(file);
    expect(await planFileUnchanged(file, hash)).toBe(false);
  });

  it("is false when the read takes longer than the 1 s budget, and stays under core's 2 s describeSubmission budget", async () => {
    expect(PLAN_REREAD_TIMEOUT_MS).toBe(1000);
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs/promises")>()),
      readFile: (_path: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }));
    const slow = await import("./plan-file.js");
    vi.useFakeTimers();
    const pending = slow.planFileUnchanged("/never/returns", "hash");
    await vi.advanceTimersByTimeAsync(slow.PLAN_REREAD_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(false);
  });
});
