import { describe, expect, it } from "vitest";
import { expandConfig, parseRawConfig } from "./rules.js";
import { expand, previewLength, trimAndExpand } from "./vars.js";

describe("expand", () => {
  it("replaces every reference in one pass, so a var value's own {{...}} text stays literal", () => {
    expect(expand("{{a}} and {{b}} and {{a}}", { a: "1", b: "{{a}}" }, 0)).toBe("1 and {{a}} and 1");
  });

  it("names the rule and the reference when a var is missing, never reading the prototype", () => {
    expect(() => expand("x {{nope}}", {}, 3)).toThrow("rules[3]: unknown variable {{nope}}");
    expect(() => expand("{{toString}}", {}, 0)).toThrow("rules[0]: unknown variable {{toString}}");
  });

  it("leaves text that is not a reference alone", () => {
    expect(expand("{{ spaced }} {single} {{1bad}}", { a: "x" }, 0)).toBe("{{ spaced }} {single} {{1bad}}");
  });
});

describe("trimAndExpand", () => {
  it("trims the text first and keeps a var value's own spaces", () => {
    expect(trimAndExpand("  [{{a}}]  \n", { a: " pad " }, 0)).toBe("[ pad ]");
  });

  it("throws like expand", () => {
    expect(() => trimAndExpand(" {{x}} ", {}, 1)).toThrow("rules[1]: unknown variable {{x}}");
  });
});

describe("previewLength", () => {
  it("counts the trimmed text with every known var expanded", () => {
    expect(previewLength("  go {{a}}  ", { a: "123456" })).toEqual({ length: 9, unknown: [] });
    expect(previewLength("", {})).toEqual({ length: 0, unknown: [] });
    expect(previewLength("   ", {})).toEqual({ length: 0, unknown: [] });
  });

  it("leaves an unknown reference in the text, counts it as written, and lists it once in first-seen order", () => {
    expect(previewLength("{{b}} {{a}} {{b}} {{c}}", { c: "x" })).toEqual({
      length: "{{b}} {{a}} {{b}} x".length,
      unknown: ["b", "a"],
    });
  });

  it("does not throw for a name on the prototype, and does not expand a var's own text twice", () => {
    expect(previewLength("{{constructor}}", {})).toEqual({ length: 15, unknown: ["constructor"] });
    expect(previewLength("{{a}}", { a: "{{b}}" })).toEqual({ length: 5, unknown: [] });
  });

  it("counts what the server counts: the expanded length of the rule", () => {
    const vars = { big: "x".repeat(10), pad: " p " };
    for (const text of ["  head {{big}} tail  ", "[{{pad}}]", "{{big}}{{big}}", "none"]) {
      const raw = parseRawConfig({ vars, rules: [{ instructions: text }] });
      expect(previewLength(text, vars).length).toBe(expandConfig(raw).rules[0].instructions!.length);
    }
  });
});
