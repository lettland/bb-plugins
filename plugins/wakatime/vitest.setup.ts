import { vi } from "vitest";

// Tests inject `exec` or stub this; if anything falls through to the real
// execFile it must fail loudly instead of spawning a wakatime-cli.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(() => {
    throw new Error("real execFile called under vitest");
  }),
}));
