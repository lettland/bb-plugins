import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  budgetReport,
  cacheProblem,
  describeType,
  formatGroups,
  groupOverflows,
  notCheckable,
  type ThreadType,
} from "./budget.js";
import { snapshotOf } from "./cache-fixture.js";
import { parseConfig } from "./rules.js";

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "model-instructions-budget-")));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const rulesOf = (rules: unknown[]) => parseConfig(JSON.stringify(rules)).rules;
const x = (length: number) => "x".repeat(length);

describe("cacheProblem", () => {
  const ok = snapshotOf([], []);

  it("is null when both lists are loaded and the last refresh worked", () => {
    expect(cacheProblem(ok)).toBeNull();
  });

  it.each([
    ["never loaded", { providers: { loaded: false } }, "provider list"],
    ["last refresh failed", { providers: { failed: true } }, "provider list"],
  ])("names the provider list when it %s", (_label, over, expected) => {
    expect(cacheProblem(snapshotOf([], [], over))).toBe(expected);
  });

  it.each([
    ["never loaded", { projects: { loaded: false } }],
    ["last refresh failed", { projects: { failed: true } }],
  ])("names the project list when it %s", (_label, over) => {
    expect(cacheProblem(snapshotOf([], [], over))).toBe("project list");
  });

  it("names the provider list first when both are unusable", () => {
    expect(
      cacheProblem(snapshotOf([], [], { providers: { loaded: false }, projects: { loaded: false } })),
    ).toBe("provider list");
  });

  it("words the refusal exactly", () => {
    expect(notCheckable("provider list")).toBe("budget not checkable yet: provider list not loaded; retry");
    expect(notCheckable("project list")).toBe("budget not checkable yet: project list not loaded; retry");
  });
});

describe("budgetReport", () => {
  it("resolves provider × model × role × (project + no project)", () => {
    const report = budgetReport(
      rulesOf([{ instructions: "x" }]),
      [],
      snapshotOf(
        [
          ["claude-code", ["opus", "sonnet"]],
          ["codex", ["gpt"]],
        ],
        [["p1", []], ["p2", []]],
      ),
    );
    expect(report.checked).toBe(3 * 2 * 3);
    expect(report.overflowing).toEqual([]);
  });

  it("still checks the no-project entry when there are no projects", () => {
    expect(budgetReport([], [], snapshotOf([["a", ["m"]]], [])).checked).toBe(2);
  });

  it("checks nothing without providers or models", () => {
    expect(budgetReport([], [], snapshotOf([], [["p", []]])).checked).toBe(0);
    expect(budgetReport([], [], snapshotOf([["a", []]], [["p", []]])).checked).toBe(0);
  });

  it("reports the length with separators and the matched rules of an overflowing type", () => {
    const rules = rulesOf([
      { instructions: x(2000) },
      { threads: "child", instructions: x(2000) },
      { project: "big", instructions: x(100) },
    ]);
    const report = budgetReport(rules, [], snapshotOf([["claude-code", ["opus"]]], [["big", []], ["small", []]]));
    expect(report.overflowing).toEqual([
      // top-level + big: 2000 + 2 + 100 is fine, so only the child types can overflow
      { provider: "claude-code", model: "opus", role: "child", project: "big", length: 4104, rules: [0, 1, 2] },
    ]);
    expect(report.checked).toBe(6);
  });

  it("compares with the limit, so exactly 4096 passes and 4097 overflows", () => {
    const at = (second: number) =>
      budgetReport(
        rulesOf([{ instructions: x(2048) }, { instructions: x(second) }]),
        [],
        snapshotOf([["a", ["m"]]], []),
      ).overflowing;
    expect(at(2046)).toEqual([]);
    expect(at(2047)).toHaveLength(2);
  });

  it("does not count a skills-only rule", () => {
    const report = budgetReport(
      rulesOf([{ skills: "a" }, { instructions: x(4096) }]),
      [],
      snapshotOf([["a", ["m"]]], []),
    );
    expect(report.overflowing).toEqual([]);
  });

  it("matches a scope rule through the project's checkout paths only", () => {
    const root = path.join(tmp, "work");
    mkdirSync(path.join(root, "repo"), { recursive: true });
    const rules = rulesOf([
      { instructions: x(2500) },
      { scope: "work", instructions: x(2500) },
    ]);
    const report = budgetReport(
      rules,
      [{ name: "work", paths: [root] }],
      snapshotOf(
        [["a", ["m"]]],
        [["in-scope", [path.join(root, "repo")]], ["out-of-scope", [path.join(tmp, "elsewhere")]]],
      ),
    );
    expect(report.overflowing.map((type) => [type.project, type.role])).toEqual([
      ["in-scope", "top-level"],
      ["in-scope", "child"],
    ]);
  });

  it("matches the project rules against the name, and the no-project entry against an empty name", () => {
    const rules = rulesOf([
      { project: "p*", instructions: x(3000) },
      { skipProjects: "p*", instructions: x(3000) },
      { project: "", instructions: x(1100) },
    ].slice(0, 2));
    const report = budgetReport(rules, [], snapshotOf([["a", ["m"]]], [["p1", []]]));
    expect(report.overflowing).toEqual([]);
    const both = budgetReport(
      rulesOf([{ instructions: x(3000) }, { project: "*", instructions: x(1100) }]),
      [],
      snapshotOf([["a", ["m"]]], [["p1", []]]),
    );
    // "*" also matches the empty project name of the no-project entry
    expect(both.overflowing.map((type) => type.project)).toEqual(["p1", "", "p1", ""]);
  });
});

describe("groupOverflows and formatGroups", () => {
  const type = (over: Partial<ThreadType>): ThreadType => ({
    provider: "claude-code",
    model: "opus",
    role: "top-level",
    project: "p",
    length: 5000,
    rules: [0],
    ...over,
  });
  const rules = rulesOf([{ name: "guard", instructions: "g" }, { instructions: "h" }]);

  it("groups by the set of matched rules and orders groups by their longest type", () => {
    const groups = groupOverflows(
      [
        type({ length: 4100, rules: [0] }),
        type({ length: 4300, rules: [0, 1] }),
        type({ length: 4200, rules: [0] }),
      ],
      rules,
    );
    expect(groups.map((group) => group.rules)).toEqual([["guard", "rules[1]"], ["guard"]]);
    expect(groups[1].shown.map((t) => t.length)).toEqual([4200, 4100]);
    expect(groups.map((group) => group.more)).toEqual([0, 0]);
  });

  it("lists at most 5 thread types, longest first, then counts the rest", () => {
    const types = Array.from({ length: 8 }, (_, i) => type({ project: `p${i}`, length: 4097 + i }));
    const [group] = groupOverflows(types, rules);
    expect(group.shown.map((t) => t.project)).toEqual(["p7", "p6", "p5", "p4", "p3"]);
    expect(group.more).toBe(3);
    expect(formatGroups([group])).toEqual([
      "over the 4096-character limit with guard:",
      '  claude-code opus top-level project "p7": 4104',
      '  claude-code opus top-level project "p6": 4103',
      '  claude-code opus top-level project "p5": 4102',
      '  claude-code opus top-level project "p4": 4101',
      '  claude-code opus top-level project "p3": 4100',
      "  and 3 more",
    ]);
  });

  it("prints exactly 5 types without an 'and more' line", () => {
    const types = Array.from({ length: 5 }, (_, i) => type({ project: `p${i}` }));
    const [group] = groupOverflows(types, rules);
    expect(group.more).toBe(0);
    expect(formatGroups([group])).toHaveLength(6);
  });

  it("names the no-project entry and the role", () => {
    expect(describeType(type({ project: "", role: "child" }))).toBe(
      "claude-code opus child project (none): 5000",
    );
  });

  it("returns nothing for no types", () => {
    expect(groupOverflows([], rules)).toEqual([]);
    expect(formatGroups([])).toEqual([]);
  });
});
