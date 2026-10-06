import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  effectiveConfig,
  globalDefaultsFrom,
  parseMainlines,
  readProjectConfig,
  setAutoApprovePlans,
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
      }),
    ).toEqual({
      enabled: true,
      mergeEligibleMainlines: ["master", "trunk"],
      reviewMode: "devkit",
    });
  });

  it("falls back to master when the mainline list is empty", () => {
    expect(
      globalDefaultsFrom({
        enabled: false,
        mergeEligibleMainlines: "  ",
        reviewMode: "auto",
      }).mergeEligibleMainlines,
    ).toEqual(["master"]);
  });

  it("falls back to auto for an unknown review mode", () => {
    expect(
      globalDefaultsFrom({
        enabled: true,
        mergeEligibleMainlines: "master",
        reviewMode: "nonsense",
      }).reviewMode,
    ).toBe("auto");
  });
});

describe("effectiveConfig", () => {
  const globals: GlobalDefaults = {
    enabled: true,
    mergeEligibleMainlines: ["master"],
    reviewMode: "auto",
  };

  it("uses globals when there is no project override", () => {
    expect(effectiveConfig(globals, {})).toEqual({
      enabled: true,
      mergeEligibleMainlines: ["master"],
      reviewMode: "auto",
      autoApprovePlans: false,
    });
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
});
