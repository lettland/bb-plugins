// Origin: BB thread thr_69ubadfky5 — a project could not use the runtime without committing
// .bb-runtime.json and its scripts. A project can now keep the manifest, its scripts and its
// overlay in a per-project host directory under the runtime root. That directory is
// executable input, so it is trusted only when it is not writable by anyone but the user.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  GIT_EXCLUDE_LINES,
  ensureGitExcludes,
  gitExcludeStatus,
  loadResolvedManifest,
  resolveManifestLocation,
} from "../src/cli-registration.mjs";
import { buildContainerPlan } from "../src/container-plan.mjs";
import { manifestDigest, validateManifest } from "../src/manifest.mjs";
import {
  hostManifestPathFor,
  loadPolicy,
  loadRegistry,
  manifestSourceOf,
  projectDirectoryFor,
  projectsDirectory,
  readTrustedHostManifest,
  resolvePolicyScript,
} from "../src/registry.mjs";
import { buildRuntimeInvocation } from "../src/runtime-tool.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ID = "proj_hostdir";
const DIGEST = "b".repeat(64);
const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (cwd, ...args) => execFileAsync("git", ["-C", cwd, ...args], { env: gitEnvironment });

const manifestDocument = {
  version: 1,
  containers: { app: { service: "app", mounts: [{ host: ".", container: "/app" }] } },
  lifecycle: { ensure: ["bash", "ensure.sh"] },
  operations: {
    probe: { kind: "host", argv: ["bash", "scripts/probe.sh"] },
  },
};

async function createFixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "shared-runtime-hostdir-")));
  t.after(async () => {
    await chmod(path.join(root, "runtime", "projects", PROJECT_ID), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const runtimeRoot = path.join(root, "runtime");
  const primaryRoot = path.join(root, "primary");
  await mkdir(projectsDirectory(runtimeRoot), { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  await chmod(projectsDirectory(runtimeRoot), 0o700);
  await mkdir(primaryRoot);
  await git(primaryRoot, "init", "--quiet");
  const hostDirectory = projectDirectoryFor(PROJECT_ID, runtimeRoot);
  await mkdir(path.join(hostDirectory, "scripts"), { recursive: true, mode: 0o700 });
  await chmod(hostDirectory, 0o700);
  await chmod(path.join(hostDirectory, "scripts"), 0o700);
  const manifestPath = hostManifestPathFor(PROJECT_ID, runtimeRoot);
  const content = JSON.stringify(manifestDocument);
  await writeFile(manifestPath, content, { mode: 0o600 });
  await writeFile(path.join(hostDirectory, "ensure.sh"), "#!/bin/bash\n", { mode: 0o700 });
  await writeFile(path.join(hostDirectory, "scripts", "probe.sh"), "#!/bin/bash\n", { mode: 0o700 });
  return { root, runtimeRoot, primaryRoot, hostDirectory, manifestPath, content };
}

async function writePolicyFile(fixture, overrides = {}) {
  const policyPath = path.join(projectsDirectory(fixture.runtimeRoot), `${PROJECT_ID}.json`);
  await writeFile(
    policyPath,
    JSON.stringify({
      projectId: PROJECT_ID,
      trustedHostId: "host_local",
      primaryRoot: fixture.primaryRoot,
      worktreeRoot: path.join(fixture.root, "worktrees"),
      worktreeDirectoryName: "primary",
      gitCommonDir: path.join(fixture.primaryRoot, ".git"),
      dockerPath: "/usr/local/bin/docker",
      manifestSha256: manifestDigest(fixture.content),
      manifestPath: fixture.manifestPath,
      containers: { app: "demo_app" },
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return policyPath;
}

async function loadedPolicy(fixture, overrides) {
  const registry = await loadRegistry(fixture.runtimeRoot);
  assert.deepEqual(registry.problems, []);
  void overrides;
  return registry.policies.get(PROJECT_ID);
}

function withUid(uid, body) {
  const original = process.getuid;
  process.getuid = () => uid;
  return Promise.resolve()
    .then(body)
    .finally(() => {
      process.getuid = original;
    });
}

test("a host-directory policy derives its script root and a repository policy keeps the primary checkout", async (t) => {
  const fixture = await createFixture(t);
  await writePolicyFile(fixture);
  const hostPolicy = await loadedPolicy(fixture);
  assert.equal(hostPolicy.manifestError, null);
  assert.equal(hostPolicy.scriptRoot, fixture.hostDirectory);
  assert.equal(hostPolicy.manifestPath, fixture.manifestPath);
  assert.equal(manifestSourceOf(hostPolicy), "host-dir");

  // Both directions: a repository manifest and a custom path never move the script root.
  await writePolicyFile(fixture, { manifestPath: undefined });
  const repoPolicy = await loadPolicy(path.join(projectsDirectory(fixture.runtimeRoot), `${PROJECT_ID}.json`));
  assert.equal(repoPolicy.scriptRoot, fixture.primaryRoot);
  assert.equal(manifestSourceOf(repoPolicy), "repo");
  await writePolicyFile(fixture, { manifestPath: path.join(fixture.primaryRoot, ".bb-runtime.json") });
  assert.equal(
    manifestSourceOf(
      await loadPolicy(path.join(projectsDirectory(fixture.runtimeRoot), `${PROJECT_ID}.json`)),
    ),
    "repo",
  );
  await writePolicyFile(fixture, { manifestPath: "/trusted/elsewhere.json" });
  const customPolicy = await loadPolicy(path.join(projectsDirectory(fixture.runtimeRoot), `${PROJECT_ID}.json`));
  assert.equal(customPolicy.scriptRoot, fixture.primaryRoot);
  assert.equal(manifestSourceOf(customPolicy), "custom");

  // The script root is never read from the policy file.
  await writePolicyFile(fixture, { manifestPath: undefined, scriptRoot: fixture.hostDirectory });
  assert.equal(
    (await loadPolicy(path.join(projectsDirectory(fixture.runtimeRoot), `${PROJECT_ID}.json`))).scriptRoot,
    fixture.primaryRoot,
  );
  await writePolicyFile(fixture, { scriptRoot: "/tmp/evil" });
  assert.equal(
    (await loadPolicy(path.join(projectsDirectory(fixture.runtimeRoot), `${PROJECT_ID}.json`))).scriptRoot,
    fixture.hostDirectory,
  );
});

test("the host project directory is not a registry entry and project ids are validated", async (t) => {
  const fixture = await createFixture(t);
  const registry = await loadRegistry(fixture.runtimeRoot);
  assert.equal(registry.policies.size, 0);
  assert.deepEqual(registry.problems, []);
  assert.throws(() => projectDirectoryFor("../escape", fixture.runtimeRoot), /project id is invalid/);
  assert.equal(
    projectDirectoryFor(PROJECT_ID, fixture.runtimeRoot),
    path.join(fixture.runtimeRoot, "projects", PROJECT_ID),
  );
});

test("a host manifest is loaded from the checked descriptor only when the directory and file are private", async (t) => {
  const fixture = await createFixture(t);
  await writePolicyFile(fixture);

  let policy = await loadedPolicy(fixture);
  assert.equal(policy.manifestError, null, "a correct setup passes");
  assert.equal(policy.manifestStale, false);
  assert.equal(policy.manifestDigest, manifestDigest(fixture.content));

  for (const mode of [0o755, 0o750, 0o770, 0o701]) {
    await chmod(fixture.hostDirectory, mode);
    policy = await loadedPolicy(fixture);
    assert.match(policy.manifestError, /must have mode 0700; fix: chmod 700 /, mode.toString(8));
    assert.equal(policy.manifest, null);
    assert.equal(policy.manifestStale, true);
  }
  await chmod(fixture.hostDirectory, 0o700);
  assert.equal((await loadedPolicy(fixture)).manifestError, null, "0700 passes again");

  for (const mode of [0o660, 0o606, 0o666]) {
    await chmod(fixture.manifestPath, mode);
    policy = await loadedPolicy(fixture);
    assert.match(policy.manifestError, /group- or world-writable; fix: chmod go-w /, mode.toString(8));
  }
  await chmod(fixture.manifestPath, 0o644);
  assert.equal((await loadedPolicy(fixture)).manifestError, null, "read-only to others is allowed");
  await chmod(fixture.manifestPath, 0o600);

  const spare = path.join(fixture.root, "spare.json");
  await link(fixture.manifestPath, spare);
  assert.match((await loadedPolicy(fixture)).manifestError, /more than one hard link/);
  await rm(spare);
  assert.equal((await loadedPolicy(fixture)).manifestError, null);

  const real = path.join(fixture.root, "real-manifest.json");
  await writeFile(real, fixture.content, { mode: 0o600 });
  await rm(fixture.manifestPath);
  await symlink(real, fixture.manifestPath);
  assert.match((await loadedPolicy(fixture)).manifestError, /is a symlink/);
  await rm(fixture.manifestPath);

  await mkdir(fixture.manifestPath);
  assert.match((await loadedPolicy(fixture)).manifestError, /is not a regular file|EISDIR/);
  await rm(fixture.manifestPath, { recursive: true });

  assert.match((await loadedPolicy(fixture)).manifestError, /Shared runtime manifest missing/);

  await writeFile(fixture.manifestPath, "{ not json", { mode: 0o600 });
  assert.match((await loadedPolicy(fixture)).manifestError, /is not valid JSON/);
  await writeFile(fixture.manifestPath, fixture.content, { mode: 0o600 });

  const movedAside = `${fixture.hostDirectory}-real`;
  await chmod(fixture.hostDirectory, 0o700);
  await execFileAsync("mv", [fixture.hostDirectory, movedAside]);
  assert.match((await loadedPolicy(fixture)).manifestError, /Shared runtime manifest missing/, "no directory");
  await symlink(movedAside, fixture.hostDirectory);
  assert.match((await loadedPolicy(fixture)).manifestError, /is a symlink or not a directory/);
  await rm(fixture.hostDirectory);
  await writeFile(fixture.hostDirectory, "a file, not a directory");
  assert.match((await loadedPolicy(fixture)).manifestError, /is a symlink or not a directory/);
  await rm(fixture.hostDirectory);
  await execFileAsync("mv", [movedAside, fixture.hostDirectory]);
  assert.equal((await loadedPolicy(fixture)).manifestError, null);
});

test("a host manifest or directory owned by another user is refused", async (t) => {
  const fixture = await createFixture(t);
  const realUid = process.getuid();
  await withUid(realUid + 1, async () => {
    await assert.rejects(
      readTrustedHostManifest(fixture.hostDirectory, fixture.manifestPath),
      /proj_hostdir is not owned by the current user; fix: chown/,
    );
  });
  // The directory check passes for its real owner; only the file is foreign.
  const original = process.getuid;
  let calls = 0;
  process.getuid = () => (calls++ === 0 ? realUid : realUid + 1);
  try {
    await assert.rejects(
      readTrustedHostManifest(fixture.hostDirectory, fixture.manifestPath),
      /\.bb-runtime\.json is not owned by the current user; fix: chown/,
    );
  } finally {
    process.getuid = original;
  }
  assert.equal((await readTrustedHostManifest(fixture.hostDirectory, fixture.manifestPath)).digest, manifestDigest(fixture.content));
});

test("a read error other than a missing file or a symlink is not reported as a trust failure", async (t) => {
  const fixture = await createFixture(t);
  await chmod(fixture.manifestPath, 0o000);
  if (process.getuid() !== 0) {
    await assert.rejects(readTrustedHostManifest(fixture.hostDirectory, fixture.manifestPath), { code: "EACCES" });
  }
  await chmod(fixture.manifestPath, 0o600);
  // A directory that cannot be inspected at all: the parent is a file.
  await assert.rejects(
    readTrustedHostManifest(path.join(fixture.manifestPath, "child"), path.join(fixture.manifestPath, "child", "m.json")),
    { code: "ENOTDIR" },
  );
});

test("host-directory scripts are trusted only along user-owned, non-writable, non-link paths", async (t) => {
  const fixture = await createFixture(t);
  await writePolicyFile(fixture);
  const policy = await loadedPolicy(fixture);
  const ensure = path.join(fixture.hostDirectory, "ensure.sh");
  const probe = path.join(fixture.hostDirectory, "scripts", "probe.sh");

  assert.equal(resolvePolicyScript(policy, "ensure.sh"), ensure, "a regular user-owned script resolves");
  assert.equal(resolvePolicyScript(policy, "scripts/probe.sh"), probe);
  assert.equal(resolvePolicyScript(policy, "./scripts/../ensure.sh"), ensure, "the path is normalized");

  // Group-writable script.
  await chmod(ensure, 0o770);
  assert.throws(() => resolvePolicyScript(policy, "ensure.sh"), /ensure\.sh is group- or world-writable/);
  await chmod(ensure, 0o700);
  assert.equal(resolvePolicyScript(policy, "ensure.sh"), ensure);
  // Group-writable script directory.
  await chmod(path.join(fixture.hostDirectory, "scripts"), 0o770);
  assert.throws(() => resolvePolicyScript(policy, "scripts/probe.sh"), /scripts is group- or world-writable/);
  await chmod(path.join(fixture.hostDirectory, "scripts"), 0o700);
  // Group-writable script root.
  await chmod(fixture.hostDirectory, 0o770);
  assert.throws(() => resolvePolicyScript(policy, "ensure.sh"), /is group- or world-writable/);
  await chmod(fixture.hostDirectory, 0o700);

  // Hard-linked script.
  const alias = path.join(fixture.root, "alias.sh");
  await link(ensure, alias);
  assert.throws(() => resolvePolicyScript(policy, "ensure.sh"), /ensure\.sh has more than one hard link/);
  await rm(alias);
  assert.equal(resolvePolicyScript(policy, "ensure.sh"), ensure);

  // A symlinked script cannot point back into the branch-controlled checkout.
  const repoScript = path.join(fixture.primaryRoot, "evil.sh");
  await writeFile(repoScript, "#!/bin/bash\n", { mode: 0o700 });
  await rm(ensure);
  await symlink(repoScript, ensure);
  assert.throws(() => resolvePolicyScript(policy, "ensure.sh"), /ensure\.sh is a symlink/);
  await rm(ensure);
  await writeFile(ensure, "#!/bin/bash\n", { mode: 0o700 });

  // A symlinked script directory.
  const realScripts = path.join(fixture.root, "real-scripts");
  await mkdir(realScripts, { mode: 0o700 });
  await writeFile(path.join(realScripts, "probe.sh"), "#!/bin/bash\n", { mode: 0o700 });
  await rm(path.join(fixture.hostDirectory, "scripts"), { recursive: true });
  await symlink(realScripts, path.join(fixture.hostDirectory, "scripts"));
  assert.throws(() => resolvePolicyScript(policy, "scripts/probe.sh"), /scripts is a symlink/);
  await rm(path.join(fixture.hostDirectory, "scripts"));
  await mkdir(path.join(fixture.hostDirectory, "scripts"), { mode: 0o700 });
  await chmod(path.join(fixture.hostDirectory, "scripts"), 0o700);

  // A missing script, a directory where a file belongs and a file where a directory belongs.
  assert.throws(() => resolvePolicyScript(policy, "scripts/probe.sh"), /probe\.sh is missing/);
  await mkdir(probe, { mode: 0o700 });
  assert.throws(() => resolvePolicyScript(policy, "scripts/probe.sh"), /is not a regular file/);
  await rm(probe, { recursive: true });
  await writeFile(path.join(fixture.hostDirectory, "flat"), "x", { mode: 0o600 });
  assert.throws(() => resolvePolicyScript(policy, "flat/probe.sh"), /flat is not a directory/);

  // A script owned by someone else.
  await withUid(process.getuid() + 1, () => {
    assert.throws(() => resolvePolicyScript(policy, "ensure.sh"), /is not owned by the current user/);
  });
});

test("repository policies do not run host-directory checks and a missing script root fails closed", () => {
  const repoPolicy = { primaryRoot: "/workspace/example", scriptRoot: "/workspace/example" };
  assert.equal(
    resolvePolicyScript(repoPolicy, "scripts/up.sh"),
    "/workspace/example/scripts/up.sh",
    "no filesystem access for a repository script root",
  );
  for (const scriptRoot of [undefined, null, "", "relative/root"]) {
    assert.throws(
      () => resolvePolicyScript({ primaryRoot: "/workspace/example", scriptRoot }, "scripts/up.sh"),
      /script root is not set for this project/,
      String(scriptRoot),
    );
  }
});

test("lifecycle and host steps join scripts against the script root and never fall back to the primary checkout", async (t) => {
  const fixture = await createFixture(t);
  await writePolicyFile(fixture);
  const hostPolicy = await loadedPolicy(fixture);
  const ensure = buildRuntimeInvocation(hostPolicy, "ensure");
  assert.deepEqual(ensure, {
    command: "/bin/bash",
    args: [path.join(fixture.hostDirectory, "ensure.sh")],
    cwd: fixture.primaryRoot,
  });

  const workspace = {
    branchName: "bb/example",
    containerRoot: "/bb-worktrees/env_abc/primary",
    environmentId: "env_abc",
    hostRoot: path.join(fixture.root, "worktrees", "env_abc", "primary"),
    kind: "managed-worktree",
  };
  const [hostStep] = buildContainerPlan(hostPolicy, workspace, "probe");
  assert.equal(hostStep.args[0], path.join(fixture.hostDirectory, "scripts", "probe.sh"));
  assert.equal(hostStep.cwd, workspace.hostRoot, "host steps still run in the workspace");

  // Repository policy: scripts come from the primary checkout.
  const repoPolicy = Object.freeze({ ...hostPolicy, scriptRoot: hostPolicy.primaryRoot, manifestPath: undefined });
  assert.equal(buildRuntimeInvocation(repoPolicy, "ensure").args[0], path.join(fixture.primaryRoot, "ensure.sh"));
  assert.equal(buildContainerPlan(repoPolicy, workspace, "probe")[0].args[0], path.join(fixture.primaryRoot, "scripts", "probe.sh"));

  // Fail closed: a policy without a script root denies instead of using the primary checkout.
  const rootless = Object.freeze({ ...hostPolicy, scriptRoot: undefined });
  assert.throws(() => buildRuntimeInvocation(rootless, "ensure"), /script root is not set for this project/);
  assert.throws(() => buildContainerPlan(rootless, workspace, "probe"), /script root is not set for this project/);

  // A symlinked script is denied when the operation is planned.
  await rm(path.join(fixture.hostDirectory, "ensure.sh"));
  await symlink(path.join(fixture.primaryRoot, ".git", "HEAD"), path.join(fixture.hostDirectory, "ensure.sh"));
  assert.throws(() => buildRuntimeInvocation(hostPolicy, "ensure"), /ensure\.sh is a symlink/);
});

test("the manifest validators reject absolute and escaping script paths for either script root", () => {
  for (const script of ["/etc/passwd", "../outside.sh", "a/../../outside.sh"]) {
    assert.throws(
      () => validateManifest({ ...manifestDocument, lifecycle: { ensure: ["bash", script] } }),
      /repository-relative POSIX path|escapes the repository/,
      script,
    );
  }
});

test("manifest resolution takes --manifest, the registered path, the host directory, then the repository", async (t) => {
  const fixture = await createFixture(t);
  const options = { projectId: PROJECT_ID, runtimeRoot: fixture.runtimeRoot, primaryRoot: fixture.primaryRoot };
  const repoManifest = path.join(fixture.primaryRoot, ".bb-runtime.json");
  const custom = path.join(fixture.root, "custom.json");

  // Host directory only.
  assert.deepEqual(await resolveManifestLocation(options), { path: fixture.manifestPath, source: "host-dir" });
  // Repository only.
  await rm(fixture.manifestPath);
  await writeFile(repoManifest, fixture.content);
  assert.deepEqual(await resolveManifestLocation(options), { path: repoManifest, source: "repo" });
  // Both present: deny, naming both; --manifest breaks the tie.
  await writeFile(fixture.manifestPath, fixture.content, { mode: 0o600 });
  await assert.rejects(
    resolveManifestLocation(options),
    new RegExp(
      `^Error: two manifests: ${fixture.manifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} and ${repoManifest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; remove one or pass --manifest$`,
    ),
  );
  assert.deepEqual(await resolveManifestLocation({ ...options, explicit: custom }), { path: custom, source: "explicit" });
  // The registered path wins over both files; --manifest wins over the registered path.
  assert.deepEqual(await resolveManifestLocation({ ...options, registeredPath: "/registered.json" }), {
    path: "/registered.json",
    source: "registered",
  });
  assert.deepEqual(
    await resolveManifestLocation({ ...options, registeredPath: "/registered.json", explicit: custom }),
    { path: custom, source: "explicit" },
  );
  // Neither present: deny, listing every searched path and where to find the project id.
  await rm(fixture.manifestPath);
  await rm(repoManifest);
  await assert.rejects(resolveManifestLocation(options), (error) => {
    assert.match(error.message, /^No manifest found\. Searched: /);
    assert.ok(error.message.includes(fixture.manifestPath), "the concrete project directory path");
    assert.ok(error.message.includes(repoManifest), "the repository path");
    assert.match(error.message, /`bb project list`/);
    return true;
  });
  // No project id: the host directory is skipped and says so.
  await assert.rejects(
    resolveManifestLocation({ ...options, projectId: null }),
    /projects\/<projectId>\/\.bb-runtime\.json \(skipped: no single BB project was resolved\), then .*primary\/\.bb-runtime\.json/,
  );
  // No project id and a repository manifest: the repository file is used.
  await writeFile(repoManifest, fixture.content);
  assert.deepEqual(await resolveManifestLocation({ ...options, projectId: null }), { path: repoManifest, source: "repo" });
});

test("a resolved host manifest goes through the trust checks and any other manifest does not", async (t) => {
  const fixture = await createFixture(t);
  const context = { primaryRoot: fixture.primaryRoot, projectId: PROJECT_ID, runtimeRoot: fixture.runtimeRoot };
  const host = await loadResolvedManifest({ path: fixture.manifestPath, source: "host-dir" }, context);
  assert.equal(host.digest, manifestDigest(fixture.content));
  await chmod(fixture.hostDirectory, 0o755);
  await assert.rejects(
    loadResolvedManifest({ path: fixture.manifestPath, source: "host-dir" }, context),
    /must have mode 0700; fix: chmod 700/,
  );
  await chmod(fixture.hostDirectory, 0o700);
  // Without a project id nothing can be a host manifest: the plain reader runs.
  const plain = path.join(fixture.root, "plain.json");
  await writeFile(plain, fixture.content, { mode: 0o666 });
  assert.equal(
    (await loadResolvedManifest({ path: plain, source: "explicit" }, { ...context, projectId: null })).digest,
    manifestDigest(fixture.content),
  );
  assert.equal((await loadResolvedManifest({ path: plain, source: "explicit" }, context)).digest, manifestDigest(fixture.content));
});

test("the git exclude file gains the runtime lines once and keeps every existing line", async (t) => {
  const fixture = await createFixture(t);
  const excludePath = path.join(fixture.primaryRoot, ".git", "info", "exclude");
  const original = await readFile(excludePath, "utf8");

  await ensureGitExcludes(fixture.primaryRoot);
  const first = await readFile(excludePath, "utf8");
  assert.equal(first, `${original}${GIT_EXCLUDE_LINES.join("\n")}\n`);
  assert.deepEqual(await gitExcludeStatus(fixture.primaryRoot), { excludePath, missing: [] });

  await ensureGitExcludes(fixture.primaryRoot);
  assert.equal(await readFile(excludePath, "utf8"), first, "a second run adds nothing");

  // A file with no trailing newline gets one first; the user's last line stays intact.
  await writeFile(excludePath, "# mine\nbuild/");
  assert.deepEqual((await gitExcludeStatus(fixture.primaryRoot)).missing, [...GIT_EXCLUDE_LINES]);
  await ensureGitExcludes(fixture.primaryRoot);
  assert.equal(await readFile(excludePath, "utf8"), `# mine\nbuild/\n${GIT_EXCLUDE_LINES.join("\n")}\n`);

  // One line already present: only the other is appended; user lines are kept (CRLF too).
  await writeFile(excludePath, `keep-me\r\n${GIT_EXCLUDE_LINES[0]}\r\n`);
  await ensureGitExcludes(fixture.primaryRoot);
  assert.equal(await readFile(excludePath, "utf8"), `keep-me\r\n${GIT_EXCLUDE_LINES[0]}\r\n${GIT_EXCLUDE_LINES[1]}\n`);

  // Lines in the file prove nothing for git when they are the only thing there: a real status check.
  await mkdir(path.join(fixture.primaryRoot, ".bb-runtime"));
  await writeFile(path.join(fixture.primaryRoot, ".bb-runtime", "landlock-run"), "x");
  await mkdir(path.join(fixture.primaryRoot, ".bb-runtime-isolation-abc"));
  await writeFile(path.join(fixture.primaryRoot, ".bb-runtime-isolation-abc", "f"), "x");
  assert.equal((await git(fixture.primaryRoot, "status", "--porcelain")).stdout, "");
});

test("a missing info directory or exclude file is created", async (t) => {
  const fixture = await createFixture(t);
  await rm(path.join(fixture.primaryRoot, ".git", "info"), { recursive: true, force: true });
  await ensureGitExcludes(fixture.primaryRoot);
  assert.equal(
    await readFile(path.join(fixture.primaryRoot, ".git", "info", "exclude"), "utf8"),
    `${GIT_EXCLUDE_LINES.join("\n")}\n`,
  );
  assert.equal((await stat(path.join(fixture.primaryRoot, ".git", "info", "exclude"))).mode & 0o777, 0o644);

  await rm(path.join(fixture.primaryRoot, ".git", "info", "exclude"));
  assert.deepEqual((await gitExcludeStatus(fixture.primaryRoot)).missing, [...GIT_EXCLUDE_LINES], "a missing file reports every line missing");
  await ensureGitExcludes(fixture.primaryRoot);
  assert.deepEqual((await gitExcludeStatus(fixture.primaryRoot)).missing, []);
});

test("a symlinked or unwritable exclude file is refused loudly", async (t) => {
  const fixture = await createFixture(t);
  const excludePath = path.join(fixture.primaryRoot, ".git", "info", "exclude");
  const target = path.join(fixture.root, "elsewhere");
  await writeFile(target, "untouched\n");
  await rm(excludePath, { force: true });
  await symlink(target, excludePath);
  await assert.rejects(ensureGitExcludes(fixture.primaryRoot), /Refusing to write .*exclude: it is a symlink/);
  assert.equal(await readFile(target, "utf8"), "untouched\n", "nothing was written through the link");
  await rm(excludePath);

  if (process.getuid() !== 0) {
    await writeFile(excludePath, "user line\n", { mode: 0o444 });
    await assert.rejects(ensureGitExcludes(fixture.primaryRoot), /Cannot open .*exclude for appending/);
    assert.equal(await readFile(excludePath, "utf8"), "user line\n");
    await chmod(excludePath, 0o644);
  }

  // A directory in place of the file cannot be opened for appending.
  await rm(excludePath, { force: true });
  await mkdir(excludePath);
  await assert.rejects(ensureGitExcludes(fixture.primaryRoot), /Cannot open .*exclude for appending/);
});

test("a git exclude status that cannot be read is an error, not an empty file", async (t) => {
  const fixture = await createFixture(t);
  const excludePath = path.join(fixture.primaryRoot, ".git", "info", "exclude");
  await rm(excludePath, { force: true });
  await mkdir(excludePath);
  await assert.rejects(gitExcludeStatus(fixture.primaryRoot), { code: "EISDIR" });
});

test("the runtime sync invocation re-pins into the policy's own runtime root with its stored manifest path", async (t) => {
  const fixture = await createFixture(t);
  await writePolicyFile(fixture);
  const policy = await loadedPolicy(fixture);
  const { args } = buildRuntimeInvocation(policy, "sync");
  assert.deepEqual(args.slice(1), [
    "sync",
    "--project-id",
    PROJECT_ID,
    "--runtime-root",
    fixture.runtimeRoot,
    "--manifest",
    fixture.manifestPath,
    "--no-reload",
  ]);
  // Without a stored path there is no --manifest, so the resolution order applies again.
  const repoPolicy = Object.freeze({ ...policy, manifestPath: undefined });
  assert.equal(buildRuntimeInvocation(repoPolicy, "sync").args.includes("--manifest"), false);
});
