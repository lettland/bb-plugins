import * as React from "react";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";

// jsdom reports isContentEditable as undefined, so keyboard-input detection
// via the contenteditable paths needs the property patched per element.
export function patchContentEditable(element: Element, value: boolean): void {
  Object.defineProperty(element, "isContentEditable", {
    value,
    configurable: true,
  });
}

export function setActiveElement(element: Element | Document | null): void {
  Object.defineProperty(document, "activeElement", {
    value: element,
    configurable: true,
  });
}

interface MatchMediaController {
  setMatches: (query: string, matches: boolean) => void;
  matches: (query: string) => boolean;
}

// Replaces the setup file's static matchMedia stub with one whose results the
// test can flip at runtime, dispatching to every registered change listener.
export function installMatchMedia(): MatchMediaController {
  interface StubList {
    matches: boolean;
    media: string;
    onchange: unknown;
    addListener: (cb: () => void) => void;
    removeListener: (cb: () => void) => void;
    addEventListener: (type: string, cb: () => void) => void;
    removeEventListener: (type: string, cb: () => void) => void;
    dispatchEvent: () => boolean;
  }
  const lists = new Map<string, StubList & { changeListeners: Set<() => void> }>();

  const createList = (query: string) => {
    const changeListeners = new Set<() => void>();
    const list = {
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, cb: () => void) => {
        changeListeners.add(cb);
      },
      removeEventListener: (_type: string, cb: () => void) => {
        changeListeners.delete(cb);
      },
      dispatchEvent: () => true,
      changeListeners,
    };
    lists.set(query, list);
    return list;
  };

  window.matchMedia = ((query: string) => lists.get(query) ?? createList(query)) as unknown as typeof window.matchMedia;

  return {
    setMatches(query, matches) {
      const list = lists.get(query) ?? createList(query);
      list.matches = matches;
      for (const listener of list.changeListeners) listener();
    },
    matches(query) {
      const list = lists.get(query);
      if (!list) throw new Error(`no MediaQueryList created for ${query}`);
      return list.matches;
    },
  };
}

interface OverlayHarnessProps {
  compact?: boolean;
  children: (state: { open: boolean; setOpen: (open: boolean) => void }) => React.ReactNode;
}

// Controlled-open harness that also pins the viewport mode via the override
// context, so tests choose desktop vs compact without touching matchMedia.
export function OverlayHarness({ compact = false, children }: OverlayHarnessProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <CompactViewportOverrideProvider isCompactViewport={compact}>
      {children({ open, setOpen })}
    </CompactViewportOverrideProvider>
  );
}
