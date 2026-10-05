import { MANIFEST_FILE_NAME } from "./manifest.mjs";

export const usage = `Usage: bb-shared-runtime <command> [options]

Commands (run from the primary checkout of the repository):
  install           Register this repository with the shared runtime plugin and install or reload the plugin
  sync              Re-pin the manifest hash and refresh container names (same as install)
  uninstall         Remove this repository's registration (--remove-plugin also removes the plugin when no project remains)
  list              Show every project registered on this host
  doctor            Verify the registration, manifest, containers, and mounts
  validate          Validate ${MANIFEST_FILE_NAME} and list its operations
  env               Print shell exports for BB_WORKTREES_ROOT and BB_PRIMARY_ROOT
  compose-overlay   Print a Docker Compose overlay that mounts the worktree root into the declared containers

Options:
  --project-id <id>         BB project id when the checkout maps to more than one project
  --primary-root <path>     Register a primary checkout without changing directory
  --manifest <path>         Use a trusted manifest outside the repository root
  --compose-project <name>  Docker Compose project name (otherwise read from the manifest's compose.envFile)
  --docker-socket <path>    Docker socket path (otherwise DOCKER_HOST or the active docker context)
  --worktree-root <path>    BB worktree root (default: $BB_WORKTREES_ROOT or ~/.bb/worktrees)
  --runtime-root <path>     Registry root (default: ~/.bb/shared-runtime)
  --no-reload               Do not reload the plugin after writing the registration
  --remove-plugin           With uninstall: remove the plugin when no registrations remain
  --json                    Machine-readable output for list, doctor, and validate
`;

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function parseArguments(argv) {
  const options = { flags: new Set(), values: {} };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (["no-reload", "remove-plugin", "json", "help"].includes(name)) {
      options.flags.add(name);
      continue;
    }
    if (["project-id", "primary-root", "manifest", "compose-project", "docker-socket", "worktree-root", "runtime-root"].includes(name)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError(`--${name} requires a value`, 2);
      }
      options.values[name] = value;
      index += 1;
      continue;
    }
    throw new CliError(`Unknown option: ${argument}`, 2);
  }
  return { command: positional[0], rest: positional.slice(1), ...options };
}
