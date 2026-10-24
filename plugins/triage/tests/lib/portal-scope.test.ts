import { afterEach, describe, expect, test, vi } from "vitest";

import { usePortalScopeProps } from "../../lib/portal-scope.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePortalScopeProps", () => {
  test("without a build-time plugin id it scopes overlays to the portaled layer only", () => {
    expect(usePortalScopeProps()).toStrictEqual({
      "data-bb-portaled-overlay": "",
      "data-bb-plugin-root": "",
    });
  });

  test("a build-time plugin id adds the data-bb-plugin mark", () => {
    vi.stubGlobal("__BB_PLUGIN_ID__", "triage");
    expect(usePortalScopeProps()).toStrictEqual({
      "data-bb-portaled-overlay": "",
      "data-bb-plugin-root": "",
      "data-bb-plugin": "triage",
    });
  });
});
