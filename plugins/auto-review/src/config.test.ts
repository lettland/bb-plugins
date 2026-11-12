import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  defineAutoReviewSettings,
  effectiveConfig,
  globalDefaultsFrom,
  parseMainlines,
  readProjectConfig,
  readProjectConfigStatus,
  setAutoApprovePlans,
  setProjectReview,
  writeProjectConfig,
  type GlobalDefaults,
} from "./config.js";

describe("parseMainlines", () => {
  it("splits, trims, and drops empties", () => {
    expect(parseMainlines("master, main ,, personal")).toEqual([
      "master",
      "main",
      "personal",
    ]);
  });
});

describe("globalDefaultsFrom", () => {
  it("parses settings values", () => {
    expect(
      globalDefaultsFrom({
        enabled: true,
        mergeEligibleMainlines: "master,trunk",
        reviewMode: "devkit",
        planApprovalForm: false,
      }),
    ).toEqual({
      enabled: true,
      mergeEligibleMainlines: ["master", "trunk"],
      reviewMode: "devkit",
      planApprovalForm: false,
    });
  });

  it("falls back to master when the mainline list is empty", () => {
    expect(
      globalDefaultsFrom({
        enabled: false,
        mergeEligibleMainlines: "  ",
        reviewMode: "auto",
        planApprovalForm: false,
      }).mergeEligibleMainlines,
    ).toEqual(["master"]);
  });

  it("falls back to auto for an unknown review mode", () => {
    expect(
      globalDefaultsFrom({
        enabled: true,
        mergeEligibleMainlines: "master",
        reviewMode: "nonsense",
        planApprovalForm: false,
      }).reviewMode,
    ).toBe("auto");
  });

  it("passes the plan approval form switch through", () => {
    const values = { enabled: true, mergeEligibleMainlines: "master", reviewMode: "auto" };
    expect(globalDefaultsFrom({ ...values, planApprovalForm: true }).planApprovalForm).toBe(true);
    expect(globalDefaultsFrom({ ...values, planApprovalForm: false }).planApprovalForm).toBe(false);
  });
});

describe("the plan approval form setting", () => {
  it("is a global boolean, off by default, that says what it needs and how to self-test", async () => {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      const settings = defineAutoReviewSettings(host.bb);
      expect((await settings.get()).planApprovalForm).toBe(false);
      const descriptor = host.harness.registrations.settingsDescriptors.planApprovalForm;
      expect(descriptor).toMatchObject({ type: "boolean", label: "Plan approval form", default: false });
      expect(descriptor.description).toContain("experimental_holdToolCall");
      expect(descriptor.description).toContain("experimental_requireAppAnswer");
      expect(descriptor.description).toContain("If Approve is never accepted, your bb lacks experimental_requireAppAnswer: rebuild bb.");
      expect(descriptor.description).toContain("If the agent keeps working while the form is open, your bb doesn't support this; turn it off.");
      expect(descriptor.description).toContain("A toggle applies to threads started after it; a thread keeps the mode it started with.");
    } finally {
      await host.harness.dispose();
    }
  });
});

describe("effectiveConfig", () => {
  const globals: GlobalDefaults = {
    enabled: true,
    mergeEligibleMainlines: ["master"],
    reviewMode: "auto",
    planApprovalForm: false,
  };

  it("uses globals when there is no project override", () => {
    expect(effectiveConfig(globals, {})).toEqual({
      enabled: true,
      mergeEligibleMainlines: ["master"],
      reviewMode: "auto",
      autoApprovePlans: false,
      planApprovalForm: false,
    });
  });

  it("takes the plan approval form switch from the globals alone", () => {
    expect(effectiveConfig({ ...globals, planApprovalForm: true }, {}).planApprovalForm).toBe(true);
    expect(effectiveConfig({ ...globals, planApprovalForm: true }, { enabled: false }).planApprovalForm).toBe(true);
    expect(effectiveConfig({ ...globals, planApprovalForm: false }, {}).planApprovalForm).toBe(false);
  });

  it("applies a partial project override without clobbering the rest", () => {
    const config = effectiveConfig(globals, { enabled: false });
    expect(config.enabled).toBe(false);
    expect(config.mergeEligibleMainlines).toEqual(["master"]);
    expect(config.reviewMode).toBe("auto");
  });

  it("keeps plan auto-approve off unless the project turns it on", () => {
    expect(effectiveConfig(globals, {}).autoApprovePlans).toBe(false);
    expect(effectiveConfig(globals, { autoApprovePlans: true }).autoApprovePlans).toBe(true);
    expect(effectiveConfig(globals, { autoApprovePlans: false }).autoApprovePlans).toBe(false);
  });
});

describe("writeProjectConfig", () => {
  it("keeps both keys when different keys are written concurrently", async () => {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      const { bb } = host;
      await Promise.all([
        writeProjectConfig(bb, "p-1", { reviewMode: "self" }),
        setAutoApprovePlans(bb, "p-1", true, "rpc"),
        writeProjectConfig(bb, "p-1", { enabled: false }),
      ]);
      expect(await readProjectConfig(bb, "p-1")).toEqual({
        reviewMode: "self",
        autoApprovePlans: true,
        enabled: false,
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it("logs the value its own read saw as the before value", async () => {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      const { bb } = host;
      await Promise.all([
        setAutoApprovePlans(bb, "p-1", true, "rpc"),
        setAutoApprovePlans(bb, "p-1", false, "cli (terminal)"),
      ]);
      const info = host.harness.logEntries
        .filter((entry) => entry.level === "info")
        .map((entry) => entry.message);
      expect(info).toEqual([
        "plan auto-approve for project p-1: false -> true (via rpc)",
        "plan auto-approve for project p-1: true -> false (via cli (terminal))",
      ]);
    } finally {
      await host.harness.dispose();
    }
  });

  it("keeps an unknown key through writeProjectConfig and setAutoApprovePlans", async () => {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      const { bb } = host;
      await bb.storage.kv.set("project:p-1", { futureKey: { a: 1 } });
      await writeProjectConfig(bb, "p-1", { enabled: false });
      expect(await bb.storage.kv.get("project:p-1")).toEqual({ enabled: false, futureKey: { a: 1 } });
      await setAutoApprovePlans(bb, "p-1", true, "rpc");
      expect(await bb.storage.kv.get("project:p-1")).toEqual({
        enabled: false,
        autoApprovePlans: true,
        futureKey: { a: 1 },
      });
    } finally {
      await host.harness.dispose();
    }
  });

  it("setAutoApprovePlans throws on a malformed record and leaves it unchanged", async () => {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      const { bb } = host;
      const malformed = { enabled: "yes", futureKey: 1 };
      await bb.storage.kv.set("project:p-1", malformed);
      await expect(setAutoApprovePlans(bb, "p-1", true, "rpc")).rejects.toThrow(
        "stored auto-review config for project p-1 is malformed; not overwriting. Run `bb auto-review enable|disable --project p-1` to replace it (this discards the stored record).",
      );
      expect(await bb.storage.kv.get("project:p-1")).toEqual(malformed);
      expect(host.harness.logEntries.filter((entry) => entry.level === "info")).toEqual([]);
    } finally {
      await host.harness.dispose();
    }
  });

  it("setAutoApprovePlans does not throw on a valid or null record", async () => {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      const { bb } = host;
      await bb.storage.kv.set("project:p-1", { enabled: true });
      await expect(setAutoApprovePlans(bb, "p-1", true, "rpc")).resolves.toBeUndefined();
      await bb.storage.kv.set("project:p-2", null);
      await expect(setAutoApprovePlans(bb, "p-2", true, "rpc")).resolves.toBeUndefined();
      expect(await bb.storage.kv.get("project:p-2")).toEqual({ autoApprovePlans: true });
    } finally {
      await host.harness.dispose();
    }
  });

  it("writeProjectConfig replaces a malformed record and logs a warning", async () => {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      const { bb } = host;
      await bb.storage.kv.set("project:p-1", { enabled: "yes", autoApprovePlans: true });
      await writeProjectConfig(bb, "p-1", { enabled: false });
      expect(await bb.storage.kv.get("project:p-1")).toEqual({ enabled: false });
      expect(
        host.harness.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message),
      ).toEqual(["replacing malformed stored auto-review config for project p-1"]);
    } finally {
      await host.harness.dispose();
    }
  });

  it("writeProjectConfig does not warn on a valid, null or missing record", async () => {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      const { bb } = host;
      await bb.storage.kv.set("project:p-1", { autoApprovePlans: true });
      await writeProjectConfig(bb, "p-1", { enabled: false });
      await bb.storage.kv.set("project:p-2", null);
      await writeProjectConfig(bb, "p-2", { enabled: false });
      await writeProjectConfig(bb, "p-3", { enabled: false });
      expect(host.harness.logEntries.filter((entry) => entry.level === "warn")).toEqual([]);
      expect(await bb.storage.kv.get("project:p-1")).toEqual({ autoApprovePlans: true, enabled: false });
    } finally {
      await host.harness.dispose();
    }
  });
});

describe("setProjectReview", () => {
  async function withBb(body: (host: ReturnType<typeof createFakePluginHost>) => Promise<void>) {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      await body(host);
    } finally {
      await host.harness.dispose();
    }
  }

  it("round-trips on, off and default", async () => {
    await withBb(async ({ bb }) => {
      expect(await setProjectReview(bb, "p-1", "on", "rpc")).toEqual({ enabled: true });
      expect(await readProjectConfig(bb, "p-1")).toEqual({ enabled: true });
      expect(await setProjectReview(bb, "p-1", "off", "rpc")).toEqual({ enabled: false });
      expect(await readProjectConfig(bb, "p-1")).toEqual({ enabled: false });
      expect(await setProjectReview(bb, "p-1", "default", "rpc")).toEqual({});
      expect(await bb.storage.kv.get("project:p-1")).toEqual({});
    });
  });

  it("default removes enabled and keeps every other key", async () => {
    await withBb(async ({ bb }) => {
      const stored = {
        enabled: false,
        autoApprovePlans: true,
        reviewMode: "self",
        mergeEligibleMainlines: ["main", "release"],
      };
      await bb.storage.kv.set("project:p-1", stored);
      await setProjectReview(bb, "p-1", "default", "rpc");
      expect(await bb.storage.kv.get("project:p-1")).toEqual({
        autoApprovePlans: true,
        reviewMode: "self",
        mergeEligibleMainlines: ["main", "release"],
      });
      await setProjectReview(bb, "p-1", "on", "rpc");
      expect(await bb.storage.kv.get("project:p-1")).toEqual({
        enabled: true,
        autoApprovePlans: true,
        reviewMode: "self",
        mergeEligibleMainlines: ["main", "release"],
      });
    });
  });

  it("writes nothing for default when no record exists", async () => {
    await withBb(async ({ bb }) => {
      expect(await setProjectReview(bb, "p-1", "default", "rpc")).toEqual({});
      expect(await bb.storage.kv.list("project:")).toEqual([]);
    });
  });

  it("throws on a malformed stored record and leaves it unchanged", async () => {
    await withBb(async ({ bb }) => {
      const malformed = { enabled: "yes", autoApprovePlans: true, reviewMode: "self", extra: 1 };
      for (const review of ["on", "off", "default"] as const) {
        await bb.storage.kv.set("project:p-1", malformed);
        await expect(setProjectReview(bb, "p-1", review, "rpc")).rejects.toThrow(
          "stored auto-review config for project p-1 is malformed; not overwriting. Run `bb auto-review enable|disable --project p-1` to replace it (this discards the stored record).",
        );
        expect(JSON.stringify(await bb.storage.kv.get("project:p-1"))).toBe(JSON.stringify(malformed));
      }
      await bb.storage.kv.set("project:p-2", "not an object");
      await expect(setProjectReview(bb, "p-2", "off", "rpc")).rejects.toThrow("malformed");
      expect(await bb.storage.kv.get("project:p-2")).toBe("not an object");
    });
  });

  it("does not throw on a valid record", async () => {
    await withBb(async ({ bb }) => {
      await bb.storage.kv.set("project:p-1", { reviewMode: "devkit", autoApprovePlans: false });
      await expect(setProjectReview(bb, "p-1", "off", "rpc")).resolves.toEqual({
        reviewMode: "devkit",
        autoApprovePlans: false,
        enabled: false,
      });
    });
  });

  it("keeps an unknown key through on, off and default", async () => {
    await withBb(async ({ bb }) => {
      await bb.storage.kv.set("project:p-1", { enabled: false, futureKey: { a: 1 } });
      await setProjectReview(bb, "p-1", "on", "rpc");
      expect(await bb.storage.kv.get("project:p-1")).toEqual({ enabled: true, futureKey: { a: 1 } });
      await setProjectReview(bb, "p-1", "off", "rpc");
      expect(await bb.storage.kv.get("project:p-1")).toEqual({ enabled: false, futureKey: { a: 1 } });
      await setProjectReview(bb, "p-1", "default", "rpc");
      expect(await bb.storage.kv.get("project:p-1")).toEqual({ futureKey: { a: 1 } });
    });
  });

  it("logs a change with the override it saw as the before value and who changed it", async () => {
    await withBb(async (host) => {
      const { bb } = host;
      await setProjectReview(bb, "p-1", "off", "rpc");
      await setProjectReview(bb, "p-1", "default", "rpc");
      await setProjectReview(bb, "p-1", "on", "cli");
      const info = host.harness.logEntries
        .filter((entry) => entry.level === "info")
        .map((entry) => entry.message);
      expect(info).toEqual([
        "auto-review for project p-1: default -> off (via rpc)",
        "auto-review for project p-1: off -> default (via rpc)",
        "auto-review for project p-1: default -> on (via cli)",
      ]);
    });
  });

  it("does not log a set to the value already stored", async () => {
    await withBb(async (host) => {
      const { bb } = host;
      await setProjectReview(bb, "p-1", "default", "rpc");
      await setProjectReview(bb, "p-1", "off", "rpc");
      const logged = host.harness.logEntries.length;
      await setProjectReview(bb, "p-1", "off", "rpc");
      await bb.storage.kv.set("project:p-2", { enabled: true });
      await setProjectReview(bb, "p-2", "on", "rpc");
      expect(host.harness.logEntries).toHaveLength(logged);
    });
  });

  it("keeps both keys when written concurrently with other writers", async () => {
    await withBb(async ({ bb }) => {
      await Promise.all([
        setProjectReview(bb, "p-1", "off", "rpc"),
        setAutoApprovePlans(bb, "p-1", true, "rpc"),
        writeProjectConfig(bb, "p-1", { reviewMode: "self" }),
      ]);
      expect(await readProjectConfig(bb, "p-1")).toEqual({
        enabled: false,
        autoApprovePlans: true,
        reviewMode: "self",
      });
    });
  });
});

describe("readProjectConfig", () => {
  it("strips unknown keys and reads a malformed or missing record as {}", async () => {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      const { bb } = host;
      await bb.storage.kv.set("project:p-ok", { enabled: true, futureKey: 1 });
      expect(await readProjectConfig(bb, "p-ok")).toEqual({ enabled: true });
      await bb.storage.kv.set("project:p-bad", { enabled: "yes" });
      expect(await readProjectConfig(bb, "p-bad")).toEqual({});
      expect(await readProjectConfig(bb, "p-none")).toEqual({});
    } finally {
      await host.harness.dispose();
    }
  });
});

describe("readProjectConfigStatus", () => {
  it("is malformed only for a stored record that fails the schema, from one read", async () => {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      const { bb } = host;
      expect(await readProjectConfigStatus(bb, "p-none")).toEqual({ config: {}, malformed: false });
      await bb.storage.kv.set("project:p-null", null);
      expect(await readProjectConfigStatus(bb, "p-null")).toEqual({ config: {}, malformed: false });
      await bb.storage.kv.set("project:p-ok", { enabled: true, futureKey: 1 });
      expect(await readProjectConfigStatus(bb, "p-ok")).toEqual({
        config: { enabled: true, futureKey: 1 },
        malformed: false,
      });
      await bb.storage.kv.set("project:p-bad", { enabled: "yes" });
      expect(await readProjectConfigStatus(bb, "p-bad")).toEqual({ config: {}, malformed: true });
      await bb.storage.kv.set("project:p-str", "not an object");
      expect(await readProjectConfigStatus(bb, "p-str")).toEqual({ config: {}, malformed: true });
    } finally {
      await host.harness.dispose();
    }
  });
});
