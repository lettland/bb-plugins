#!/usr/bin/env node
import { CliError, parseArguments, usage } from "../src/cli-arguments.mjs";
import { commandInstall, commandUninstall } from "../src/cli-registration.mjs";
import {
  commandComposeOverlay,
  commandDoctor,
  commandEnv,
  commandList,
  commandValidate,
} from "../src/cli-inspect.mjs";

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.command || options.flags.has("help") || options.command === "help") {
    process.stdout.write(usage);
    return;
  }
  switch (options.command) {
    case "install":
      return commandInstall(options, { reloadByDefault: true });
    case "sync":
      return commandInstall(options, { reloadByDefault: true });
    case "uninstall":
      return commandUninstall(options);
    case "list":
      return commandList(options);
    case "doctor":
      return commandDoctor(options);
    case "validate":
      return commandValidate(options);
    case "env":
      return commandEnv();
    case "compose-overlay":
      return commandComposeOverlay();
    default:
      throw new CliError(`Unknown command: ${options.command}\n\n${usage}`, 2);
  }
}

main().catch((error) => {
  const message = error instanceof CliError ? error.message : error?.stack ?? String(error);
  process.stderr.write(`${message}\n`);
  process.exit(error instanceof CliError ? error.exitCode : 1);
});

export { containerNames } from "../src/cli-registration.mjs";
export { parseEnvFile } from "../src/cli-host.mjs";
export { createHash } from "node:crypto";
