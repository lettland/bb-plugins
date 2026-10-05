import { describe, expect, it } from "vitest";
import {
  effectiveConfig,
  globalDefaultsFrom,
  parseMainlines,
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
    });
  });

  it("applies a partial project override without clobbering the rest", () => {
    const config = effectiveConfig(globals, { enabled: false });
    expect(config.enabled).toBe(false);
    expect(config.mergeEligibleMainlines).toEqual(["master"]);
    expect(config.reviewMode).toBe("auto");
  });
});
