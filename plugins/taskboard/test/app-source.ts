import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const taskboardDir = new URL('../', import.meta.url).pathname;

async function featureFiles(): Promise<string[]> {
  const featuresDir = join(taskboardDir, 'features');
  const entries = await readdir(featuresDir, { recursive: true }).catch(
    () => [] as string[]
  );
  return entries
    .filter(entry => /\.tsx?$/u.test(entry))
    .sort()
    .map(entry => join(featuresDir, entry));
}

/** `app.tsx` plus every `.ts`/`.tsx` under `features/`, so assertions survive file splits. */
export async function loadAppSource(): Promise<string> {
  const files = [join(taskboardDir, 'app.tsx'), ...(await featureFiles())];
  const sources = await Promise.all(files.map(file => readFile(file, 'utf8')));
  return sources.join('\n');
}

const OPENERS = '([{';
const CLOSERS = ')]}';

// A `function` ends at the `}` that closes its body; a `const` at the `;` ending
// its statement. Brace/paren/bracket depth is tracked naively (no string or regex
// awareness), which holds for this codebase's declarations.
function declarationEnd(source: string, start: number, isFunction: boolean): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char)) {
      depth -= 1;
      // `): { ...type } {` — a braced return type is followed by the body brace.
      if (isFunction && depth === 0 && char === '}' && !/^\s*\{/u.test(source.slice(index + 1, index + 40))) {
        return index + 1;
      }
    } else if (!isFunction && depth === 0 && char === ';') return index + 1;
  }
  return source.length;
}

function declarationsNamed(source: string, name: string): string[] {
  const starts = [
    {
      isFunction: true,
      pattern: new RegExp(`^[ \\t]*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${name}\\b`, 'gmu')
    },
    {
      isFunction: false,
      pattern: new RegExp(`^[ \\t]*(?:export\\s+)?const\\s+${name}\\s*[=:]`, 'gmu')
    }
  ];
  return starts.flatMap(({ isFunction, pattern }) =>
    [...source.matchAll(pattern)].map(match =>
      source.slice(match.index, declarationEnd(source, match.index, isFunction))
    )
  );
}

/**
 * Full text of the named declarations (`function X`, `const X =`, `export function X`),
 * wherever they live in `source`. Several names form a union: list the original name
 * first, then any child component or hook the logic may move into. At least one name
 * must resolve; absent extra candidates are ignored.
 */
export function declarationBody(source: string, names: readonly string[]): string {
  const bodies = names.flatMap(name => declarationsNamed(source, name));
  assert.ok(bodies.length > 0, `Missing declaration: ${names.join(' | ')}`);
  return bodies.join('\n');
}
