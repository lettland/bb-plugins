import { describe, expect, it } from "vitest";
import { detachedBy, isHistoryWritingGit, mayMoveRemoteRef } from "./detect-shell.js";

describe("isHistoryWritingGit", () => {
  it("matches a plain history-writing git command", () => {
    expect(isHistoryWritingGit("git commit -m 'message'")).toBe(true);
    expect(isHistoryWritingGit("git status")).toBe(false);
  });

  it("is false when env assignments fill the whole command", () => {
    expect(isHistoryWritingGit("FOO=1")).toBe(false);
  });

  it("is false when git's flags end the command", () => {
    expect(isHistoryWritingGit("git -C")).toBe(false);
  });
});

describe("mayMoveRemoteRef", () => {
  it("matches remote-moving words and plain text alike", () => {
    expect(mayMoveRemoteRef("git push origin main")).toBe(true);
    expect(mayMoveRemoteRef("git fetch origin main:main")).toBe(true);
    expect(mayMoveRemoteRef("echo hello")).toBe(false);
  });
});

describe("detachedBy", () => {
  it("names the detach word, the at scheduler and container flags", () => {
    expect(detachedBy("nohup sleep 5")).toBe("nohup");
    expect(detachedBy("at now -f job.sh")).toBe("at");
    expect(detachedBy("docker run -d img")).toBe("docker … -d");
    expect(detachedBy("docker compose up")).toBe("docker … up");
    expect(detachedBy("echo nothing")).toBeUndefined();
  });
});
