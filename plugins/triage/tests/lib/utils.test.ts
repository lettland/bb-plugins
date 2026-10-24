import { describe, expect, test } from "vitest";

import { cn, formatHomePathForDisplay } from "../../lib/utils.ts";

describe("cn", () => {
  test("joins class values and lets tailwind-merge resolve conflicts", () => {
    expect(cn("a", "b")).toBe("a b");
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("a", false, undefined, null, "b")).toBe("a b");
    expect(cn()).toBe("");
  });
});

describe("formatHomePathForDisplay", () => {
  test("abbreviates the conventional macOS, Linux, root, and Windows homes", () => {
    expect(formatHomePathForDisplay("/Users/alex/dev/plugin")).toBe("~/dev/plugin");
    expect(formatHomePathForDisplay("/Users/alex")).toBe("~");
    expect(formatHomePathForDisplay("/Users/alex/")).toBe("~/");
    expect(formatHomePathForDisplay("/home/alex/work")).toBe("~/work");
    expect(formatHomePathForDisplay("/root/notes")).toBe("~/notes");
    expect(formatHomePathForDisplay("/root")).toBe("~");
    expect(formatHomePathForDisplay("C:\\Users\\alex\\repo")).toBe("~\\repo");
    expect(formatHomePathForDisplay("c:/users/alex/repo")).toBe("~/repo");
  });

  test("leaves every other path untouched for actions that need the original", () => {
    expect(formatHomePathForDisplay("/opt/data/set")).toBe("/opt/data/set");
    expect(formatHomePathForDisplay("/Users")).toBe("/Users");
    expect(formatHomePathForDisplay("/var/home/alex")).toBe("/var/home/alex");
    expect(formatHomePathForDisplay("relative/path")).toBe("relative/path");
  });
});
