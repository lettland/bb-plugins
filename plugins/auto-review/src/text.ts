/** Control and format characters, plus the Unicode line and paragraph separators (Zl, Zp) and NEL. */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u0085]/gu;

/** Drops control and format characters (newlines, bidi marks and zero-width characters included). */
export function stripControl(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}
