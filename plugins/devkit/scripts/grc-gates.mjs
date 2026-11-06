// Content gates for scripts/sync-grc.mjs: everything that rejects upstream text which hides content from a human reader.
// Kept in its own module so the sync script stays small and the gates can be tested on their own.

export class GrcSyncError extends Error {}

export function fail(message) {
  throw new GrcSyncError(message);
}

/**
 * Invisible or direction-changing code points, by Unicode property: every format character (\p{Cf}: soft hyphen,
 * zero-width and bidi marks, Arabic and Syriac number and end-of-text signs, invisible operators, BOM, interlinear
 * annotation, shorthand and musical formatting, tags), every control character except tab, LF and CR (\p{Cc}),
 * the line and paragraph separators (\p{Zl}, \p{Zp}), U+FFFC, the fillers U+115F, U+1160, U+3164 and U+FFA0, and
 * the whole tag block U+E0000-U+E007F (U+E0000 and U+E0002-U+E001F are unassigned, so \p{Cf} misses them).
 * The combining marks that are not format characters are separate alternatives (a combining mark inside a
 * character class is read as one glyph with its neighbour): U+034F, the Khmer vowels U+17B4 and U+17B5, the
 * Mongolian free variation selectors U+180B-U+180D and U+180F, the variation selectors U+FE00-U+FE0E and the
 * variation selector supplement U+E0100-U+E01EF.
 * U+FE0F (emoji variation selector) is checked separately by STRAY_VS16_RE.
 */
export const INVISIBLE_RE =
  /\p{Cf}|(?![\t\n\r])\p{Cc}|[\p{Zl}\p{Zp}\uFFFC\u115F\u1160\u3164\uFFA0\u{E0000}-\u{E007F}]|\u034F|[\u17B4-\u17B5]|[\u180B-\u180D]|\u180F|[\uFE00-\uFE0E]|[\u{E0100}-\u{E01EF}]/u;
/**
 * U+FE0F is allowed only directly after a pictographic code point, or in a keycap sequence (`[0-9#*]`, U+FE0F,
 * U+20E3). Anywhere else (after a space or a letter, doubled, at a line start) it hides nothing visible.
 */
const STRAY_VS16_RE = /(?<!\p{Extended_Pictographic})(?:(?<![0-9#*])\uFE0F|\uFE0F(?!\u20E3))/u;

const LINE_BREAK_RE = /\r\n|\r|\n/u;
/** The container prefix of a line: spaces, tabs, `>` and list markers (`-`, `*`, `+`, `1.`, `1)`) followed by a space, a tab or the line end. */
const CONTAINER_PREFIX_RE = /^(?:[ \t]|>|(?:[-*+]|[0-9]+[.)])(?=[ \t]|$))*/u;

/** The index of the first `[` that no odd run of backslashes escapes, or -1. */
function firstUnescapedOpen(line) {
  let backslashes = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\") backslashes += 1;
    else {
      if (char === "[" && backslashes % 2 === 0) return index;
      backslashes = 0;
    }
  }
  return -1;
}

/**
 * A fail-closed line rule for Markdown link-reference definitions. They render as nothing, so their label,
 * destination and title can hide text. Exact CommonMark matching was bypassed again and again, so this rule does not
 * parse: it works line by line (a split on CRLF, CR or LF; no pattern spans lines, so it runs in linear time) and
 * rejects every line that could be the start or the end of a definition label. After the container prefix is removed,
 * a line is rejected when it starts with `[` and holds `]:`, or when a `]:` has no unescaped `[` before it on the
 * line (the label was opened on an earlier line). A `[` is escaped when an odd number of backslashes directly
 * precede it. The first `]:` is the strictest one: if an unescaped `[` precedes it, it precedes every later `]:`.
 * The rule also rejects such lines inside code blocks and prose lines such as `[PLACEHOLDER]: for [PURPOSE]`;
 * that is intended.
 * Returns the 1-based number of the first rejected line, or 0.
 */
function linkDefinitionLine(text) {
  const lines = text.split(LINE_BREAK_RE);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const close = line.indexOf("]:");
    if (close < 0) continue;
    const open = firstUnescapedOpen(line);
    if (open < 0 || open > close || line.startsWith("[", CONTAINER_PREFIX_RE.exec(line)[0].length)) return index + 1;
  }
  return 0;
}

/** Reject any copied text that hides content from a human reader. */
export function assertVisibleContent(text, label) {
  if (text.includes("<!--")) fail(`${label}: contains an HTML comment`);
  const definitionLine = linkDefinitionLine(text);
  if (definitionLine > 0) {
    fail(`${label}: line ${definitionLine} looks like a Markdown link-reference definition (\`[label]:\`), which can hide text; refusing it`);
  }
  const hit = INVISIBLE_RE.exec(text) ?? STRAY_VS16_RE.exec(text);
  if (hit) fail(`${label}: contains invisible character U+${hit[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
}

/** `references/<name>.md` as upstream cites it (inline code, bold, table cell, bullet, prose). */
const PATH_CITATION_RE = /references\/([a-z0-9][a-z0-9-]*)\.md/gu;
/** A bare `<name>.md` that no letter, digit, `_`, `-`, `/` or `.` precedes. */
const BARE_CITATION_RE = /(?<![A-Za-z0-9_\-/.])([a-z0-9][a-z0-9-]*)\.md/gu;
/** Same shape, but a `/` or `.` before the name still counts: the final gate is stricter than the rewrite. */
const BARE_LEFTOVER_RE = /(?<![A-Za-z0-9_-])([a-z0-9][a-z0-9-]*)\.md/gu;

/**
 * Rewrite upstream reference citations to `devkit_load_skill` calls: first `references/<name>.md`,
 * then bare `<name>.md` for the framework's own reference files. Fails on a cited name with no file.
 */
export function rewriteCitations(text, slug, names, label) {
  const known = new Set(names);
  const call = (name) => `devkit_load_skill({ reference: "${slug}-${name}" })`;
  const pathPass = text.replace(PATH_CITATION_RE, (_match, name) => {
    if (!known.has(name)) fail(`${label}: cites references/${name}.md, which does not exist upstream`);
    return call(name);
  });
  return pathPass.replace(BARE_CITATION_RE, (match, name) => (known.has(name) ? call(name) : match));
}

/** Fail when upstream text cites an excluded reference, by `references/<name>.md` or by a bare `<name>.md`. */
export function assertNoExcludedCitations(text, excluded, label) {
  for (const match of text.matchAll(BARE_LEFTOVER_RE)) {
    if (excluded.has(match[1])) fail(`${label}: cites the excluded reference "${match[1]}", which is not vendored`);
  }
}

export function assertNoLeftoverCitations(text, names, label) {
  if (text.includes("references/")) fail(`${label}: still contains "references/" after the citation rewrite`);
  const known = new Set(names);
  for (const match of text.matchAll(BARE_LEFTOVER_RE)) {
    if (known.has(match[1])) fail(`${label}: still contains the bare reference name "${match[1]}.md" after the citation rewrite`);
  }
}

