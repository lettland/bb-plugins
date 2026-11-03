import { describe, expect, it } from "vitest";
import { decide } from "./decide.js";

const ELIGIBLE = ["master"];

describe("decide branch policy", () => {
  it("feature branch on eligible mainline: commit + merge", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "bb/feature",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: true });
  });

  it("feature branch with a multi-segment name (eligible): commit + merge", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "fix/oh-1/feature",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: true });
  });

  it("on the eligible mainline: commit, no merge", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "master",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("never merges a top-level branch (develop) into an eligible mainline", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "develop",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("never merges a mainline into itself, even when its name contains a slash", () => {
    expect(
      decide({
        base: "team/master",
        currentBranch: "team/master",
        mergeEligibleMainlines: ["team/master"],
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("never merges a detached HEAD", () => {
    expect(
      decide({
        base: "master",
        currentBranch: null,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("feature branch on non-eligible mainline: commit, no merge", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "fix/oh-1/feature",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("on the non-eligible mainline: nothing (no commit)", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "main",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: false, merge: false });
  });

  it("never commits on a non-eligible mainline whose name contains a slash", () => {
    expect(
      decide({
        base: "team/main",
        currentBranch: "team/main",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: false, merge: false });
  });

  it("top-level branch on a non-eligible mainline: nothing (no commit)", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "dev",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: false, merge: false });
  });

  it("feature branch with a multi-segment name on a non-eligible base: commit, no merge", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "OH-6155/rest-cleanup-batch-7",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("detached HEAD with a non-eligible base: nothing (no commit)", () => {
    expect(
      decide({
        base: "main",
        currentBranch: null,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: false, merge: false });
  });
});
