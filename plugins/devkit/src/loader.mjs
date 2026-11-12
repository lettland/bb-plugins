import { readFile } from "node:fs/promises";
import path from "node:path";

/** Frontmatter slug shape: lowercase, digits, single hyphens, no leading/trailing/double hyphen. */
export const SLUG_RE = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
/** A reference is a bare basename (no separators, no extension) drawn from the same charset. */
export const REFERENCE_RE = SLUG_RE;

/** Conservative per-response budget. Not a platform-enforced cap on tool output — a self-imposed one. */
export const MAX_BODY_BYTES = 60_000;

const FIND_HINT = "Use devkit_find_skills to discover valid slugs.";
const REF_HINT = "Reference names come from the skill body that cites them.";
const NATIVE_HINT = "This tool loads devkit skills only. If the name is in your own skills list, load it the way that list says: read the SKILL.md path it gives, or use your provider's skill tool.";
const DEVKIT_FIND_HINT = "For a devkit skill, use devkit_find_skills to discover valid slugs.";

/** Codepoint-safe truncation to a UTF-8 byte budget (never splits a multi-byte char). */
export function truncateToBytes(str, maxBytes) {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return { text: str, truncated: false };
  let bytes = 0;
  let out = "";
  for (const ch of str) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return { text: out, truncated: true };
}

/**
 * Read one skill body (by slug), or one named shared reference (by reference).
 * Provide `reference` to read a shared reference; otherwise provide `slug`.
 * Every path component is allowlist-validated and the resolved path is contained
 * to dataRoot before any read, so `..`/absolute/`/` inputs cannot escape.
 *
 * @param {string} dataRoot absolute path to the committed `content/` directory
 * @param {string} [slug]
 * @param {string} [reference] optional shared reference basename (without `.md`)
 * @returns {Promise<import("./loader.mjs").LoadResult>}
 */
export async function loadSkill(dataRoot, slug, reference) {
  const loadingReference = reference !== undefined;

  if (loadingReference) {
    if (!REFERENCE_RE.test(reference)) {
      return { ok: false, code: "invalid_reference", message: `Invalid reference '${reference}'. ${REF_HINT}` };
    }
  } else {
    if (slug === undefined) {
      return { ok: false, code: "invalid_slug", message: `Provide a slug or a reference. ${FIND_HINT}` };
    }
    if (!SLUG_RE.test(slug)) {
      return { ok: false, code: "invalid_slug", message: `Invalid slug '${slug}'. ${NATIVE_HINT} ${DEVKIT_FIND_HINT}` };
    }
  }

  const root = path.resolve(dataRoot);
  const target = loadingReference
    ? path.resolve(root, "references", `${reference}.md`)
    : path.resolve(root, "skills", slug, "SKILL.md");

  // Defence in depth: the allowlist already forbids separators, but re-check containment.
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { ok: false, code: "out_of_bounds", message: "Resolved path escaped the data root." };
  }

  let content;
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    const code = (error && typeof error === "object" && "code" in error) ? error.code : undefined;
    if (code === "ENOENT") {
      const what = loadingReference
        ? `Reference '${reference}' not found. ${REF_HINT}`
        : `Skill '${slug}' not found in devkit. ${NATIVE_HINT} ${DEVKIT_FIND_HINT}`;
      return { ok: false, code: "not_found", message: what };
    }
    const what = loadingReference ? `reference '${reference}'` : `skill '${slug}'`;
    return { ok: false, code: "read_failed", message: `Could not read ${what}.` };
  }

  const { text, truncated } = truncateToBytes(content, MAX_BODY_BYTES);
  if (truncated) {
    const marker = loadingReference
      ? `\n\n[truncated: reference '${reference}' exceeds ${MAX_BODY_BYTES} bytes]`
      : `\n\n[truncated: skill '${slug}' body exceeds ${MAX_BODY_BYTES} bytes; if it cites references, request them by name]`;
    return { ok: true, slug: slug ?? null, reference: reference ?? null, content: text + marker, truncated: true };
  }

  return { ok: true, slug: slug ?? null, reference: reference ?? null, content, truncated: false };
}
