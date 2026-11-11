import { describe, expect, it } from "vitest";
import { snapshotOf } from "./cache-fixture.js";
import { runCli, type CliDeps } from "./cli.js";
import type { Caches } from "./projects.js";

// The plugin always finishes one refresh at startup, so a list that is neither loaded nor failed is
// only reachable here, with hand-made state.
function depsFor(snapshot: ReturnType<typeof snapshotOf>): CliDeps {
  return {
    rules: () => [],
    scopes: () => [],
    skills: () => [],
    caches: { snapshot: () => snapshot } as unknown as Caches,
    overBudget: () => [],
    events: () => [],
    threads: {
      get: async () => {
        throw new Error("unused");
      },
      defaultExecutionOptions: async () => null,
    },
    profiles: () => ({ state: "absent" }),
    profilesFile: "/profiles.json",
    ignoredSettingScopes: () => [],
    profile: { kv: { list: async () => [] } } as unknown as CliDeps["profile"],
    setup: {} as CliDeps["setup"],
    importDirSkills: {} as CliDeps["importDirSkills"],
  };
}

describe("status: cache state", () => {
  it.each([
    [{ loaded: false, failed: false }, "not loaded"],
    [{ loaded: false, failed: true }, "not loaded, last refresh failed"],
    [{ loaded: true, failed: true }, "loaded, last refresh failed"],
    [{ loaded: true, failed: false }, "loaded"],
  ])("words %j as %s", async (state, text) => {
    const result = await runCli(["status"], {}, depsFor(snapshotOf([], [], { providers: state })));
    expect(result.stdout).toContain(`cache: provider list ${text}; project list loaded`);
  });
});
