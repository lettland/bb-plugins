import path from "node:path";

import { deny, assertNonEmptyString } from "./runtime-common.mjs";

function validateRelativePath(value, { allowRootSlash = false } = {}) {
  if (typeof value !== "string" || value === "" || value.includes("\0")) {
    deny("path is missing or invalid");
  }
  if (path.isAbsolute(value) || value.startsWith("-")) {
    deny("path must be relative and may not be an option");
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  const isRoot = normalized.replace(/\/+$/u, "") === ".";
  if (isRoot && normalized !== "." && allowRootSlash) {
    return ".";
  }
  if (
    isRoot ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    deny("path escapes the workspace");
  }
  return normalized;
}

export function buildSearchInvocation(workspaceRoot, input, defaultPath = ".") {
  const query = assertNonEmptyString(input?.query, "search query");
  if (query.includes("\0") || query.length > 1_000) {
    deny("search query is invalid");
  }
  const requestedPath = input?.path;
  const fallback = defaultPath === "." ? "." : defaultPath;
  const rawPath =
    typeof requestedPath === "string" && requestedPath.trim() === ""
      ? fallback
      : (requestedPath ?? fallback);
  const searchPath = rawPath === "." ? "." : validateRelativePath(rawPath, { allowRootSlash: true });
  return {
    acceptedExitCodes: [0, 1],
    command: "rg",
    args: ["--color=never", "--line-number", "--fixed-strings", "--", query, searchPath],
    cwd: workspaceRoot,
  };
}

const gitSafetyArgs = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
]);

function safeGitArgs(args) {
  return [...gitSafetyArgs, ...args];
}

function buildFixedGitInvocation(workspaceRoot, args) {
  return {
    command: "git",
    args: safeGitArgs(args),
    cwd: workspaceRoot,
  };
}

export function buildGitInvocation(workspaceRoot, input) {
  switch (input?.operation) {
    case "status":
      return {
        command: "git",
        args: safeGitArgs(["status", "--short", "--branch"]),
        cwd: workspaceRoot,
      };
    case "diff":
      return {
        command: "git",
        args: safeGitArgs(
          input.staged === true ? ["diff", "--cached", "--"] : ["diff", "--"],
        ),
        cwd: workspaceRoot,
      };
    case "log":
      return {
        command: "git",
        args: safeGitArgs(["log", "-20", "--oneline", "--decorate"]),
        cwd: workspaceRoot,
      };
    case "add": {
      if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > 100) {
        deny("path list is missing or invalid");
      }
      return {
        command: "git",
        args: safeGitArgs(["add", "--", ...input.paths.map((value) => validateRelativePath(value))]),
        cwd: workspaceRoot,
      };
    }
    case "commit": {
      const message = assertNonEmptyString(input.message, "commit message");
      if (
        message.length > 500 ||
        message.includes("\0") ||
        /\[[^\]\r\n]+\]/.test(message) ||
        /(?:Co-Authored-By|Claude-Session)\s*:/i.test(message)
      ) {
        deny("commit message contains prohibited control text");
      }
      return {
        command: "git",
        args: safeGitArgs(["commit", "--no-verify", "-m", message]),
        cwd: workspaceRoot,
      };
    }
    default:
      deny(`unsupported git operation ${JSON.stringify(input?.operation)}`);
  }
}

export function validateManagedWorktreeBranch(workspace) {
  if (workspace.kind !== "managed-worktree") {
    deny("primary fast-forward requires a managed worktree");
  }
  const branchName = assertNonEmptyString(workspace.branchName, "worktree branch");
  if (
    !/^bb\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branchName) ||
    branchName.includes("..") ||
    branchName.includes("//") ||
    branchName.includes("@{") ||
    branchName.endsWith("/") ||
    branchName.endsWith(".") ||
    branchName.endsWith(".lock")
  ) {
    deny("worktree branch is outside the managed BB namespace");
  }
  return branchName;
}

export function buildFastForwardPrimaryPlan(policy, workspace) {
  const branchName = validateManagedWorktreeBranch(workspace);
  return [
    buildFixedGitInvocation(policy.primaryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    buildFixedGitInvocation(policy.primaryRoot, [
      "merge",
      "--ff-only",
      `refs/heads/${branchName}`,
    ]),
  ];
}

export function buildRebasePrimaryInvocation(_policy, workspace, primaryBranch) {
  validateManagedWorktreeBranch(workspace);
  if (primaryBranch !== "main" && primaryBranch !== "master") {
    deny(`primary checkout is on non-mainline branch ${JSON.stringify(primaryBranch)}`);
  }
  return buildFixedGitInvocation(
    workspace.hostRoot,
    ["rebase", `refs/heads/${primaryBranch}`],
  );
}

export function buildRebasePrimaryPreflightPlan(policy, workspace) {
  const branchName = validateManagedWorktreeBranch(workspace);
  const [primaryBranchInvocation] = buildFastForwardPrimaryPlan(policy, workspace);
  return {
    branchName,
    invocations: [
      primaryBranchInvocation,
      buildFixedGitInvocation(workspace.hostRoot, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]),
      buildFixedGitInvocation(workspace.hostRoot, ["status", "--porcelain"]),
    ],
  };
}

export function buildRebaseRecoveryInvocation(workspace, operation) {
  validateManagedWorktreeBranch(workspace);
  if (operation === "rebase_continue") {
    return buildFixedGitInvocation(workspace.hostRoot, [
      "-c",
      "core.editor=true",
      "rebase",
      "--continue",
    ]);
  }
  if (operation === "rebase_abort") {
    return buildFixedGitInvocation(workspace.hostRoot, ["rebase", "--abort"]);
  }
  deny(`unsupported rebase recovery operation ${JSON.stringify(operation)}`);
}
