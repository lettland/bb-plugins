import { describe, expect, test } from "vitest";

import {
  useBrowserDimmingModal,
  useIsBrowserDimmingModalOpen,
} from "../../hooks/useBrowserDimmingModal.ts";

describe("plugin flavor of the browser dimming hook", () => {
  test("dimming requests are a no-op and no dimming state is ever reported", () => {
    expect(useBrowserDimmingModal(true)).toBeUndefined();
    expect(useBrowserDimmingModal(false)).toBeUndefined();
    expect(useIsBrowserDimmingModalOpen()).toBe(false);
  });
});
