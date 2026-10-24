import { describe, expect, it } from "vitest";
import {
  KEEPER_INTERVAL_MS,
  errorMessage,
  httpStatus,
  sleep,
  staleReason,
} from "./shared.js";

describe("errorMessage", () => {
  it("returns an Error's message", () => {
    expect(errorMessage(new Error("bad thing"))).toBe("bad thing");
  });

  it("stringifies values that are not Errors", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("httpStatus", () => {
  it("reads a numeric status", () => {
    expect(httpStatus({ status: 404 })).toBe(404);
  });

  it("returns null when the status is not a number", () => {
    expect(httpStatus({ status: "404" })).toBeNull();
  });

  it("returns null when there is no status", () => {
    expect(httpStatus(new Error("no status"))).toBeNull();
    expect(httpStatus(null)).toBeNull();
  });
});

describe("staleReason", () => {
  it("names a thread that is no longer pending", () => {
    expect(
      staleReason({ status: "idle", archivedAt: null, deletedAt: null }),
    ).toBe("thread is idle");
  });

  it("reports a deleted thread before an archived one", () => {
    expect(
      staleReason({ status: "pending", archivedAt: 5, deletedAt: 7 }),
    ).toBe("thread was deleted");
  });

  it("names an archived thread", () => {
    expect(
      staleReason({ status: "pending", archivedAt: 5, deletedAt: null }),
    ).toBe("thread was archived");
  });

  it("returns null for a live pending thread", () => {
    expect(
      staleReason({ status: "pending", archivedAt: null, deletedAt: null }),
    ).toBeNull();
  });
});

describe("sleep", () => {
  it("resolves immediately for an already-aborted signal", async () => {
    await sleep(KEEPER_INTERVAL_MS * 100, AbortSignal.abort());
  });
});
