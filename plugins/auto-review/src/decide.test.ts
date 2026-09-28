import { describe, expect, it } from "vitest";
import { decide } from "./decide.js";

const ELIGIBLE = ["master"];

describe("decide branch policy", () => {
  it("worktree on eligible mainline: commit + merge", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "bb/feature",
        isDedicatedWorktree: true,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: true });
  });

  it("worktree on non-eligible mainline: commit only", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "bb/feature",
        isDedicatedWorktree: true,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("primary checkout on a feature branch: commit + merge (eligible)", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "fix/oh-1/feature",
        isDedicatedWorktree: false,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: true });
  });

  it("primary checkout on a feature branch: nothing when the root is protected (non-eligible)", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "feature",
        isDedicatedWorktree: false,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: false, merge: false });
  });

  it("primary checkout on eligible mainline: commit, no merge", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "master",
        isDedicatedWorktree: false,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("primary checkout on non-eligible mainline: nothing (no commit)", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "main",
        isDedicatedWorktree: false,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: false, merge: false });
  });

  it("never merges when on the base branch, even in a worktree", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "master",
        isDedicatedWorktree: true,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("never merges a top-level branch (develop) into an eligible mainline", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "develop",
        isDedicatedWorktree: false,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("never merges a top-level branch, even in a worktree", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "develop",
        isDedicatedWorktree: true,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("never merges a mainline into itself, even when its name contains a slash", () => {
    expect(
      decide({
        base: "team/master",
        currentBranch: "team/master",
        isDedicatedWorktree: false,
        mergeEligibleMainlines: ["team/master"],
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("never merges a detached HEAD", () => {
    expect(
      decide({
        base: "master",
        currentBranch: null,
        isDedicatedWorktree: true,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("worktree on a non-eligible mainline branch: commit, no merge", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "main",
        isDedicatedWorktree: true,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });
});
