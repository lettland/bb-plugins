import { spawn } from "node:child_process";

const OUTPUT_LIMIT_BYTES = 120_000;

export function invocationExitIsAccepted(invocation, code, signal) {
  if (signal !== null || !Number.isInteger(code)) {
    return false;
  }
  return (invocation.acceptedExitCodes ?? [0]).includes(code);
}

export function runInvocation(invocation, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        ...invocation.environment,
        ...options.env,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    const collect = (current, chunk) => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length > OUTPUT_LIMIT_BYTES) {
        overflow = true;
        return combined.subarray(0, OUTPUT_LIMIT_BYTES);
      }
      return combined;
    };
    child.stdout.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = collect(stderr, chunk);
    });
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      const result = {
        code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        overflow,
      };
      if (!invocationExitIsAccepted(invocation, code, signal)) {
        reject(
          Object.assign(
            new Error(
              `command failed with exit ${code ?? "null"}${signal ? ` (${signal})` : ""}\n${result.stderr || result.stdout}`,
            ),
            { result },
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}
