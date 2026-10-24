import { describe, expect, it } from "vitest";

import {
  blurActiveKeyboardInputBeforeOverlayClose,
  blurActiveKeyboardInputBeforeOverlayOpen,
  blurActiveKeyboardInputWithin,
  isLastInputKeyboard,
} from "@/components/ui/overlay-trigger";

// Without a document the blur helpers are no-ops and the modality tracker
// never installs its listeners.
describe("overlay-trigger without a document", () => {
  it("blur helpers return without touching anything", () => {
    expect(typeof document).toBe("undefined");
    expect(() => blurActiveKeyboardInputWithin(null)).not.toThrow();
    expect(() => blurActiveKeyboardInputBeforeOverlayOpen()).not.toThrow();
    expect(() => blurActiveKeyboardInputBeforeOverlayClose()).not.toThrow();
  });

  it("the modality tracker stays in its pointer default", () => {
    expect(isLastInputKeyboard()).toBe(false);
  });
});
