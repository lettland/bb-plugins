import { describe, expect, it } from "vitest";
import { entityModeOf, fileModeOf, parseExcludeList } from "./settings.js";

describe("fileModeOf", () => {
  it("keeps the three known modes", () => {
    expect(fileModeOf("edits-and-reads")).toBe("edits-and-reads");
    expect(fileModeOf("edits")).toBe("edits");
    expect(fileModeOf("off")).toBe("off");
  });

  it("fails closed: anything else sends nothing", () => {
    for (const value of ["", "everything", "EDITS", "edits-and-reads ", "undefined"]) {
      expect(fileModeOf(value)).toBe("off");
    }
  });
});

describe("entityModeOf", () => {
  it("falls back to the title for an unknown value", () => {
    expect(entityModeOf("threadId")).toBe("threadId");
    expect(entityModeOf("bogus")).toBe("title");
  });
});

describe("parseExcludeList", () => {
  it("splits on newlines and commas and drops blanks", () => {
    expect(parseExcludeList(" a, b\n\nc ,, ")).toEqual(["a", "b", "c"]);
  });
});
