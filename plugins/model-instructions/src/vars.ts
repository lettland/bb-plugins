// Pure on purpose: no node imports, so the server and the settings form count text the same way.

export const VAR_NAME_BODY = "[A-Za-z][A-Za-z0-9_-]*";

const VAR_REF_REGEXP = new RegExp(`\\{\\{(${VAR_NAME_BODY})\\}\\}`, "g");

/** One pass, so a var value's own {{...}} text stays literal. Throws on a reference with no var. */
export function expand(
  instructions: string,
  vars: Record<string, string>,
  ruleIndex: number,
): string {
  return instructions.replace(VAR_REF_REGEXP, (ref, name: string) => {
    if (!Object.hasOwn(vars, name))
      throw new Error(`rules[${ruleIndex}]: unknown variable ${ref}`);
    return vars[name];
  });
}

/** What a rule's instructions become: trimmed first, then expanded. */
export function trimAndExpand(
  instructions: string,
  vars: Record<string, string>,
  ruleIndex: number,
): string {
  return expand(instructions.trim(), vars, ruleIndex);
}

/**
 * The length the server counts for `text` (trim, then expand), without throwing: a reference with no
 * var stays in the text as written and its name is listed once, in the order first seen.
 */
export function previewLength(
  text: string,
  vars: Record<string, string>,
): { length: number; unknown: string[] } {
  const unknown: string[] = [];
  const expanded = text.trim().replace(VAR_REF_REGEXP, (ref, name: string) => {
    if (Object.hasOwn(vars, name)) return vars[name];
    if (!unknown.includes(name)) unknown.push(name);
    return ref;
  });
  return { length: expanded.length, unknown };
}
