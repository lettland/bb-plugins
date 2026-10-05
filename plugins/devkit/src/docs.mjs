import { truncateToBytes } from "./loader.mjs";

/** Fixed, non-parameterized host — the query/libraryId never control the origin (no SSRF surface). */
// aislop-ignore-next-line ai-slop/hardcoded-url -- fixed public API endpoint
export const CONTEXT7_BASE = "https://context7.com/api/v1";
export const MAX_DOCS_BYTES = 60_000;

// Query: any printable characters (no control chars), bounded length — friendly to natural
// language while keeping the third-party egress channel length-capped.
const QUERY_RE = /^[^\u0000-\u001f\u007f]{1,200}$/u;
// Library id: a path-like id whose segments are drawn from a safe charset. Each segment must be
// a real name — never empty, ".", or ".." — so it cannot escape the /api/v1 namespace.
const LIBRARY_SEGMENT_RE = /^[\w.@-]{1,80}$/u;

/** Strip control characters so a rejected value can't inject terminal escapes when echoed. */
function safe(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 120);
}

function encodeLibraryId(libraryId) {
  // Context7 ids are written with a leading slash ("/vercel/next.js"); drop exactly one so the
  // canonical form is accepted. Any other empty segment ("//x", "a//b", "/") is still rejected.
  const segments = libraryId.replace(/^\//u, "").split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === ".." || !LIBRARY_SEGMENT_RE.test(seg)) return null;
  }
  return segments.map(encodeURIComponent).join("/");
}

/**
 * Look up library documentation via Context7. Provide `libraryId` to fetch a library's docs,
 * or `query` to search. If both are given, `libraryId` takes precedence and `query` is ignored.
 * The base URL is fixed; inputs are validated and the response is byte-capped.
 *
 * @param {{ query?: string, libraryId?: string }} input
 * @param {{ base?: string, fetchImpl?: typeof fetch, maxBytes?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<import("./docs.mjs").DocsResult>}
 */
export async function fetchDocs(input, opts = {}) {
  const base = opts.base ?? CONTEXT7_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_DOCS_BYTES;

  let url;
  if (input.libraryId !== undefined) {
    const encoded = encodeLibraryId(input.libraryId);
    if (encoded === null) {
      return { ok: false, message: `Invalid libraryId '${safe(input.libraryId)}'. Use a Context7 id like "/vercel/next.js".` };
    }
    url = `${base}/${encoded}?type=txt`;
  } else if (input.query !== undefined) {
    if (!QUERY_RE.test(input.query)) {
      return { ok: false, message: "Invalid query: use up to 200 printable characters (no control characters)." };
    }
    url = `${base}/search?query=${encodeURIComponent(input.query)}`;
  } else {
    return { ok: false, message: "Provide a query or a libraryId." };
  }

  let content;
  try {
    const res = await fetchImpl(url, opts.signal ? { signal: opts.signal } : {});
    if (!res.ok) {
      return { ok: false, message: `Docs request failed (HTTP ${res.status}).` };
    }
    content = await res.text();
  } catch {
    return { ok: false, message: "Docs request failed (network error or cancelled)." };
  }

  const { text, truncated } = truncateToBytes(content, maxBytes);
  return { ok: true, url, content: truncated ? `${text}\n[truncated: response exceeds ${maxBytes} bytes]` : text };
}
