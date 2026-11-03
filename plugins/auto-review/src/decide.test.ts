import { describe, expect, it } from "vitest";
import { decide } from "./decide.js";

const ELIGIBLE = ["master"];

describe("decide branch policy", () => {
  it("worktree on eligible mainline: commit + merge", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "bb/feature",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: true });
  });

  it("primary checkout on a feature branch (eligible): commit + merge", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "fix/oh-1/feature",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: true });
  });

  it("primary checkout on eligible mainline: commit, no merge", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "master",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("never merges when on the base branch", () => {
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

  it("primary checkout on a feature branch (non-eligible base): commit, no merge", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "fix/oh-1/feature",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("primary checkout on non-eligible mainline: nothing (no commit)", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "main",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: false, merge: false });
  });

  it("worktree on a non-eligible top-level branch (main): nothing (no commit)", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "main",
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: false, merge: false });
  });

  it("worktree on a feature branch with a non-eligible base: commit, no merge", () => {
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
