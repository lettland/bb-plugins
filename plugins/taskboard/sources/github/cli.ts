import { execFile } from 'node:child_process';

let resolvedGhPath: string | null = null;

function runFile(
  file: string,
  args: string[],
  timeoutMs = 20_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

async function resolveGhPath(): Promise<string> {
  if (resolvedGhPath !== null) return resolvedGhPath;
  for (const candidate of [
    'gh',
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh'
  ]) {
    try {
      await runFile(candidate, ['--version'], 5_000);
      resolvedGhPath = candidate;
      return candidate;
    } catch {
      // Try the next common GitHub CLI location.
    }
  }
  throw new Error('GitHub CLI is not available');
}

export async function runGh(args: string[], timeoutMs?: number): Promise<string> {
  return runFile(await resolveGhPath(), args, timeoutMs);
}
