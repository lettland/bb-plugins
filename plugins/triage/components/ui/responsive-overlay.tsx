import * as React from "react";
import { createPortal } from "react-dom";
import { usePortalScopeProps } from "../../lib/portal-scope.js";
import { cn } from "../../lib/utils.js";
import { Slot } from "@radix-ui/react-slot";

import { Drawer, DrawerContent, DrawerTitle } from "./drawer.js";
import {
  blurActiveKeyboardInputBeforeOverlayOpen,
  blurActiveKeyboardInputBeforeOverlayClose,
  blurActiveKeyboardInputWithin,
  getOverlayTriggerClassName,
  preventOverlayTriggerSelection,
} from "./overlay-trigger.js";
import { useIsCompactViewport } from "./hooks/use-compact-viewport.js";
import { usePointerCoarse } from "./hooks/use-pointer-coarse.js";

// ---------------------------------------------------------------------------
// Shared context value for responsive overlays (dropdown menus, popovers)
// ---------------------------------------------------------------------------

export interface ResponsiveOverlayContextValue {
  isCompactViewport: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ResponsiveDrawerDepthContext = React.createContext(0);
const SONNER_TOASTER_SELECTOR = "[data-sonner-toaster]";

type DrawerContentPointerDownOutsideEvent = Parameters<
  NonNullable<
    React.ComponentPropsWithoutRef<typeof DrawerContent>["onPointerDownOutside"]
  >
>[0];

function resetDrawerKeyboardStyles(drawerElement: HTMLElement | null): void {
  // v8 ignore if -- @preserve the drawer content always mounts before any close transition (responsive-overlay.tsx:320 ref={drawerContentRef}), so the keyboard-style reset never runs with a null ref.
  if (drawerElement === null) return;

  drawerElement.style.height = "";
  drawerElement.style.bottom = "";
}

function isSonnerToasterPointerTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(SONNER_TOASTER_SELECTOR) !== null
  );
}

// ---------------------------------------------------------------------------
// Hook: manages open state, mobile detection, and breakpoint-cross close.
// One useMediaQuery subscription per Root (not two).
// ---------------------------------------------------------------------------

export function useResponsiveRoot(
  controlledOpen: boolean | undefined,
  controlledOnChange: ((open: boolean) => void) | undefined,
  defaultOpen: boolean = false,
): ResponsiveOverlayContextValue {
  const isCompactViewport = useIsCompactViewport();
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (open && !next && isCompactViewport) {
        blurActiveKeyboardInputBeforeOverlayClose();
      }
      if (!isControlled) {
        setInternalOpen(next);
      }
      controlledOnChange?.(next);
    },
    [isCompactViewport, isControlled, controlledOnChange, open],
  );

  return React.useMemo(
    () => ({ isCompactViewport, open, onOpenChange }),
    [isCompactViewport, open, onOpenChange],
  );
}

// ---------------------------------------------------------------------------
// MobileTrigger: shared trigger for mobile overlays.
// Adds aria-expanded, aria-haspopup, and data-state that Radix normally
// provides on desktop but which are missing from a bare <button>.
// ---------------------------------------------------------------------------

interface MobileTriggerProps {
  asChild?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  haspopup: "menu" | "dialog";
  children: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}

export const MobileTrigger = React.forwardRef<
  HTMLButtonElement,
  MobileTriggerProps &
    Omit<
      React.ButtonHTMLAttributes<HTMLButtonElement>,
      keyof MobileTriggerProps
    >
>(
  (
    {
      asChild,
      open,
      onOpenChange,
      haspopup,
      onClick,
      children,
      className,
      ...domProps
    },
    ref,
  ) => {
    const triggerClassName = getOverlayTriggerClassName(className);
    const handleClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
      onClick?.(e);
      if (!e.defaultPrevented) {
        if (!open) {
          blurActiveKeyboardInputBeforeOverlayOpen();
        }
        onOpenChange(!open);
      }
    };

    const ariaProps = {
      "aria-expanded": open,
      "aria-haspopup": haspopup,
      "data-state": open ? "open" : "closed",
    } as const;

    if (asChild) {
      return (
        <Slot
          ref={ref}
          onClick={handleClick}
          onMouseDown={preventOverlayTriggerSelection}
          className={triggerClassName}
          {...ariaProps}
          {...domProps}
        >
          {children}
        </Slot>
      );
    }

    return (
      <button
        ref={ref}
        type="button"
        onClick={handleClick}
        onMouseDown={preventOverlayTriggerSelection}
        className={triggerClassName}
        {...ariaProps}
        {...domProps}
      >
        {children}
      </button>
    );
  },
);
MobileTrigger.displayName = "MobileTrigger";

// ---------------------------------------------------------------------------
// stripRadixContentProps: removes Radix positioning/behavior props from a
// props object so that only DOM-compatible props remain for mobile rendering.
// Derived from a single const to prevent interface/set drift.
// ---------------------------------------------------------------------------

const RADIX_CONTENT_PROP_NAMES = [
  "side",
  "sideOffset",
  "align",
  "alignOffset",
  "collisionPadding",
  "collisionBoundary",
  "arrowPadding",
  "sticky",
  "hideWhenDetached",
  "avoidCollisions",
  "onOpenAutoFocus",
  "onCloseAutoFocus",
  "onEscapeKeyDown",
  "onPointerDownOutside",
  "onFocusOutside",
  "onInteractOutside",
] as const;

type RadixContentPropName = (typeof RADIX_CONTENT_PROP_NAMES)[number];

const RADIX_CONTENT_KEYS: ReadonlySet<string> = new Set(
  RADIX_CONTENT_PROP_NAMES,
);

export function stripRadixContentProps<T extends Record<string, unknown>>(
  props: T,
): Omit<T, RadixContentPropName> {
  const result = {} as Record<string, unknown>;
  for (const key of Object.keys(props)) {
    if (!RADIX_CONTENT_KEYS.has(key)) {
      result[key] = props[key];
    }
  }
  return result as Omit<T, RadixContentPropName>;
}

// ---------------------------------------------------------------------------
// ResponsiveDrawerShell: shared scaffold for the mobile branch of any
// responsive overlay. Wraps children in Drawer > DrawerContent, with an
// optional sr-only DrawerTitle. Callers supply the body (ref, padding,
// className, etc.) since those differ between Dialog, Popover, DropdownMenu,
// and ThreadDetailSecondaryContent.
// ---------------------------------------------------------------------------

interface ResponsiveDrawerShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Sr-only label announced when the drawer opens. Omit if the caller
   * renders its own labeled heading inside children (e.g. DialogTitle).
   */
  srLabel?: string;
  /** Class name on the DrawerContent wrapper. */
  contentClassName?: string;
  /**
   * When true, the drawer can only be dragged via the handle bar. Pointer
   * events on the content area are not consumed by vaul, which would
   * otherwise call setPointerCapture on the click target and break clicks
   * inside web components (e.g. Pierre tree's shadow DOM).
   */
  handleOnly?: boolean;
  /**
   * Whether Vaul should mutate drawer height/bottom around focused inputs when
   * the visual viewport changes. Defaults off for nested drawers because the
   * parent drawer cannot distinguish a nested drawer's focused input.
   */
  repositionInputs?: boolean;
  /** Called when the DrawerContent element's own animation completes. */
  onContentAnimationEnd?: (open: boolean) => void;
  children: React.ReactNode;
}

export function ResponsiveDrawerShell({
  open,
  onOpenChange,
  srLabel,
  contentClassName,
  handleOnly,
  repositionInputs,
  onContentAnimationEnd,
  children,
}: ResponsiveDrawerShellProps) {
  const parentDrawerDepth = React.useContext(ResponsiveDrawerDepthContext);
  const drawerContentRef = React.useRef<HTMLDivElement>(null);
  const isPointerCoarse = usePointerCoarse();
  const isNestedDrawer = parentDrawerDepth > 0;
  const shouldRepositionInputs = repositionInputs ?? !isNestedDrawer;
  const resetClosingKeyboardState = React.useCallback(() => {
    blurActiveKeyboardInputWithin(drawerContentRef.current);
    resetDrawerKeyboardStyles(drawerContentRef.current);
  }, []);
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      // v8 ignore else -- @preserve the shell renders no trigger inside the drawer root (responsive-overlay.tsx:313 open={open}), so vaul only ever reports close transitions here; opens come through the controlled open prop.
      if (!nextOpen) {
        resetClosingKeyboardState();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, resetClosingKeyboardState],
  );
  const handleContentAnimationEnd =
    React.useCallback<React.AnimationEventHandler<HTMLDivElement>>(
      (event) => {
        if (event.currentTarget !== event.target) {
          return;
        }
        onContentAnimationEnd?.(open);
      },
      [onContentAnimationEnd, open],
    );
  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      if (isPointerCoarse) {
        event.preventDefault();
      }
    },
    [isPointerCoarse],
  );
  const handlePointerDownOutside = React.useCallback(
    (event: DrawerContentPointerDownOutsideEvent) => {
      if (isSonnerToasterPointerTarget(event.detail.originalEvent.target)) {
        event.preventDefault();
      }
    },
    [],
  );
  const previousOpenRef = React.useRef(open);

  React.useLayoutEffect(() => {
    if (previousOpenRef.current && !open) {
      resetClosingKeyboardState();
    }
    previousOpenRef.current = open;
  }, [open, resetClosingKeyboardState]);

  return (
    <Drawer
      open={open}
      onOpenChange={handleOpenChange}
      handleOnly={handleOnly}
      nested={isNestedDrawer}
      repositionInputs={shouldRepositionInputs}
    >
      <DrawerContent
        ref={drawerContentRef}
        className={contentClassName}
        onAnimationEnd={handleContentAnimationEnd}
        onOpenAutoFocus={handleOpenAutoFocus}
        onPointerDownOutside={handlePointerDownOutside}
      >
        <ResponsiveDrawerDepthContext.Provider value={parentDrawerDepth + 1}>
          {srLabel !== undefined ? (
            <DrawerTitle className="sr-only">{srLabel}</DrawerTitle>
          ) : null}
          {children}
        </ResponsiveDrawerDepthContext.Provider>
      </DrawerContent>
    </Drawer>
  );
}

const RESPONSIVE_DRAWER_REALIZE_FALLBACK_MS = 120;

const DRAWER_KEYBOARD_INSET_PROPERTY = "--bb-drawer-keyboard-inset";
const DRAWER_KEYBOARD_MIN_OVERLAP_PX = 80;

function resetPersistentDrawerKeyboardStyles(drawerElement: HTMLElement): void {
  drawerElement.style.height = "";
  drawerElement.style.bottom = "";
  drawerElement.style.removeProperty(DRAWER_KEYBOARD_INSET_PROPERTY);
}

function measureDrawerKeyboardOverlap({
  layoutViewportHeight,
  visualViewportHeight,
  visualViewportOffsetTop,
}: {
  layoutViewportHeight: number;
  visualViewportHeight: number;
  visualViewportOffsetTop: number;
}): number {
  const overlap = Math.round(
    layoutViewportHeight - (visualViewportHeight + visualViewportOffsetTop),
  );
  return overlap >= DRAWER_KEYBOARD_MIN_OVERLAP_PX ? overlap : 0;
}

function useDrawerKeyboardInset(
  panelRef: React.RefObject<HTMLElement | null>,
  open: boolean,
): void {
  React.useEffect(() => {
    const panel = panelRef.current;
    const visualViewport = window.visualViewport;
    if (panel === null || !open || !visualViewport) return;

    let animationFrame: number | null = null;
    const applyInset = () => {
      animationFrame = null;
      if (visualViewport.scale !== 1) {
        resetPersistentDrawerKeyboardStyles(panel);
        return;
      }
      const overlap = measureDrawerKeyboardOverlap({
        layoutViewportHeight: panel.ownerDocument.documentElement.clientHeight,
        visualViewportHeight: visualViewport.height,
        visualViewportOffsetTop: visualViewport.offsetTop,
      });
      if (overlap === 0) {
        panel.style.bottom = "";
        panel.style.removeProperty(DRAWER_KEYBOARD_INSET_PROPERTY);
        return;
      }
      panel.style.bottom = `${overlap}px`;
      panel.style.setProperty(DRAWER_KEYBOARD_INSET_PROPERTY, `${overlap}px`);
    };
    const scheduleUpdate = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      animationFrame = window.requestAnimationFrame(applyInset);
    };

    applyInset();
    visualViewport.addEventListener("resize", scheduleUpdate);
    visualViewport.addEventListener("scroll", scheduleUpdate);

    return () => {
      visualViewport.removeEventListener("resize", scheduleUpdate);
      visualViewport.removeEventListener("scroll", scheduleUpdate);
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      resetPersistentDrawerKeyboardStyles(panel);
    };
  }, [open, panelRef]);
}


export function useResponsiveDrawerRealization({
  open,
  enabled = true,
}: {
  open: boolean;
  enabled?: boolean;
}): { isContentRealized: boolean } {
  const [isContentRealized, setIsContentRealized] = React.useState(false);
  const realizeContent = React.useCallback(
    () => setIsContentRealized(true),
    [],
  );

  React.useEffect(() => {
    if (!enabled || !open || isContentRealized) {
      return;
    }

    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    firstFrame = window.requestAnimationFrame(() => {
      firstFrame = null;
      secondFrame = window.requestAnimationFrame(() => {
        secondFrame = null;
        realizeContent();
      });
    });
    const fallback = window.setTimeout(
      realizeContent,
      RESPONSIVE_DRAWER_REALIZE_FALLBACK_MS,
    );

    return () => {
      if (firstFrame !== null) {
        window.cancelAnimationFrame(firstFrame);
      }
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame);
      }
      window.clearTimeout(fallback);
    };
  }, [enabled, isContentRealized, open, realizeContent]);

  return {
    isContentRealized: enabled && isContentRealized,
  };
}


interface PersistentResponsiveDrawerShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  srLabel: string;
  contentClassName?: string;
  children: React.ReactNode;
}

const PERSISTENT_DRAWER_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const PERSISTENT_DRAWER_CLOSE_RATIO = 0.25;
const PERSISTENT_DRAWER_CLOSE_VELOCITY_PX_PER_SEC = 450;
const PERSISTENT_DRAWER_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type PersistentDrawerStackEntry = {
  panel: () => HTMLElement | null;
  dismissOnEscape: (event: KeyboardEvent) => void;
};

type PersistentDrawerStack = {
  entries: PersistentDrawerStackEntry[];
  handleKeyDown: (event: KeyboardEvent) => void;
};

const PERSISTENT_DRAWER_STACK_KEY = Symbol.for("bb.persistent-drawer-stack.v1");

function isPersistentDrawerStack(
  value: unknown,
): value is PersistentDrawerStack {
  return (
    typeof value === "object" &&
    value !== null &&
    "entries" in value &&
    Array.isArray(value.entries) &&
    "handleKeyDown" in value &&
    typeof value.handleKeyDown === "function"
  );
}

function readPersistentDrawerStack(
  ownerDocument: Document,
): PersistentDrawerStack | undefined {
  const stack: unknown = Reflect.get(
    ownerDocument,
    PERSISTENT_DRAWER_STACK_KEY,
  );
  return isPersistentDrawerStack(stack) ? stack : undefined;
}

function getDrawerFocusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(PERSISTENT_DRAWER_FOCUSABLE_SELECTOR),
  ).filter(
    (element) => element.closest('[aria-hidden="true"], [inert]') === null,
  );
}

function activeElementIsInAnotherOverlay(
  activeElement: Element | null,
  panel: HTMLElement,
): boolean {
  const overlay = activeElement?.closest<HTMLElement>(
    "[data-bb-portaled-overlay]",
  );
  return overlay !== null && overlay !== undefined && overlay !== panel;
}

function handleDrawerTab(event: KeyboardEvent, panel: HTMLElement): void {
  const activeElement = panel.ownerDocument.activeElement;
  if (
    !panel.contains(activeElement) &&
    activeElementIsInAnotherOverlay(activeElement, panel)
  ) {
    return;
  }

  const focusable = getDrawerFocusableElements(panel);
  event.preventDefault();
  if (focusable.length === 0) {
    panel.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey) {
    if (
      !panel.contains(activeElement) ||
      activeElement === panel ||
      activeElement === first
    ) {
      last?.focus({ preventScroll: true });
      return;
    }
    const index = focusable.indexOf(activeElement as HTMLElement);
    focusable[Math.max(0, index - 1)]?.focus({ preventScroll: true });
    return;
  }

  if (
    !panel.contains(activeElement) ||
    activeElement === panel ||
    activeElement === last
  ) {
    first?.focus({ preventScroll: true });
    return;
  }
  const index = focusable.indexOf(activeElement as HTMLElement);
  focusable[Math.min(focusable.length - 1, index + 1)]?.focus({
    preventScroll: true,
  });
}

function registerOpenDrawer(
  ownerDocument: Document,
  entry: PersistentDrawerStackEntry,
): () => void {
  let stack = readPersistentDrawerStack(ownerDocument);
  if (stack === undefined) {
    const entries: PersistentDrawerStackEntry[] = [];
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const topEntry = entries[entries.length - 1]!;
      const panel = topEntry.panel()!;
      if (event.key === "Escape") {
        topEntry.dismissOnEscape(event);
        event.preventDefault();
      } else if (event.key === "Tab") {
        handleDrawerTab(event, panel);
      }
    };
    stack = { entries, handleKeyDown };
    Reflect.set(ownerDocument, PERSISTENT_DRAWER_STACK_KEY, stack);
    ownerDocument.addEventListener("keydown", handleKeyDown);
  }
  stack.entries.push(entry);

  return () => {
    const currentStack = stack;
    const index = currentStack.entries.indexOf(entry);
    currentStack.entries.splice(index, 1);
    if (currentStack.entries.length === 0) {
      ownerDocument.removeEventListener("keydown", currentStack.handleKeyDown);
      Reflect.deleteProperty(ownerDocument, PERSISTENT_DRAWER_STACK_KEY);
    }
  };
}

interface UsePersistentOverlayFocusArgs {
  onBeforeCloseAutoFocus: () => void;
  open: boolean;
  panelRef: React.RefObject<HTMLElement | null>;
  requestClose: () => void;
}

function usePersistentOverlayFocus({
  onBeforeCloseAutoFocus,
  open,
  panelRef,
  requestClose,
}: UsePersistentOverlayFocusArgs): void {
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  React.useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current!;
    const ownerDocument = panel.ownerDocument;
    const previousFocus = ownerDocument.activeElement;
    returnFocusRef.current =
      previousFocus instanceof HTMLElement &&
      previousFocus !== ownerDocument.body
        ? previousFocus
        : null;
    const unregister = registerOpenDrawer(ownerDocument, {
      panel: () => panelRef.current,
      dismissOnEscape: requestClose,
    });
    panel.focus({ preventScroll: true });
    return unregister;
  }, [open, panelRef, requestClose]);

  const previousOpenRef = React.useRef(open);
  React.useLayoutEffect(() => {
    let cancelDeferredFocus: (() => void) | undefined;
    if (previousOpenRef.current && !open) {
      onBeforeCloseAutoFocus();
      const returnFocus = returnFocusRef.current;
      if (
        returnFocus?.isConnected &&
        returnFocus.closest('[aria-hidden="true"], [inert]') === null
      ) {
        returnFocus.focus({ preventScroll: true });
        if (returnFocus.ownerDocument.activeElement !== returnFocus) {
          const ownerWindow = returnFocus.ownerDocument.defaultView!;
          const frame = ownerWindow.requestAnimationFrame(() => {
            if (
              returnFocus.isConnected &&
              returnFocus.closest('[aria-hidden="true"], [inert]') === null
            ) {
              returnFocus.focus({ preventScroll: true });
            }
          });
          cancelDeferredFocus = () => ownerWindow.cancelAnimationFrame(frame);
        }
      }
      returnFocusRef.current = null;
    }
    previousOpenRef.current = open;
    return cancelDeferredFocus;
  }, [onBeforeCloseAutoFocus, open]);
}

type PersistentDrawerDrag = {
  pointerId: number;
  startY: number;
  lastY: number;
  lastTimeMs: number;
  velocityY: number;
  height: number;
};

export function PersistentResponsiveDrawerShell({
  open,
  onOpenChange,
  srLabel,
  contentClassName,
  children,
}: PersistentResponsiveDrawerShellProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const backdropRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<PersistentDrawerDrag | null>(null);
  const labelId = React.useId();
  const portalScopeProps = usePortalScopeProps();
  const transition = `transform 220ms ${PERSISTENT_DRAWER_EASING}`;
  const backdropTransition = `opacity 220ms ${PERSISTENT_DRAWER_EASING}`;
  const onOpenChangeRef = React.useRef(onOpenChange);
  React.useLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);
  const requestClose = React.useCallback(() => {
    blurActiveKeyboardInputWithin(panelRef.current);
    resetPersistentDrawerKeyboardStyles(panelRef.current!);
    onOpenChangeRef.current(false);
  }, []);
  const prepareCloseAutoFocus = React.useCallback(() => {
    blurActiveKeyboardInputWithin(panelRef.current);
    resetPersistentDrawerKeyboardStyles(panelRef.current!);
  }, []);

  usePersistentOverlayFocus({
    onBeforeCloseAutoFocus: prepareCloseAutoFocus,
    open,
    panelRef,
    requestClose,
  });

  useDrawerKeyboardInset(panelRef, open);

  const setDragPosition = React.useCallback(
    (offsetY: number, height: number, animate: boolean) => {
      const panel = panelRef.current!;
      const backdrop = backdropRef.current!;
      panel.style.transition = animate ? transition : "none";
      panel.style.transform = `translate3d(0, ${offsetY}px, 0)`;
      backdrop.style.transition = animate ? backdropTransition : "none";
      backdrop.style.opacity = String(
        Math.max(0, Math.min(1, 1 - offsetY / height)),
      );
    },
    [backdropTransition, transition],
  );

  const handleDragStart = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!open || event.button !== 0) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      const nowMs = Date.now();
      const height = Math.max(panelRef.current!.clientHeight, 1);
      dragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        lastTimeMs: nowMs,
        velocityY: 0,
        height,
      };
      setDragPosition(0, height, false);
      event.preventDefault();
    },
    [open, setDragPosition],
  );

  const handleDragMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) {
        return;
      }
      const nowMs = Date.now();
      const elapsedMs = nowMs - drag.lastTimeMs;
      if (elapsedMs > 0) {
        drag.velocityY = ((event.clientY - drag.lastY) / elapsedMs) * 1000;
        drag.lastY = event.clientY;
        drag.lastTimeMs = nowMs;
      }
      setDragPosition(
        Math.max(0, event.clientY - drag.startY),
        drag.height,
        false,
      );
      event.preventDefault();
    },
    [setDragPosition],
  );

  const finishDrag = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) {
        return;
      }
      dragRef.current = null;
      const offsetY = Math.max(0, event.clientY - drag.startY);
      const shouldClose =
        !cancelled &&
        (offsetY >= drag.height * PERSISTENT_DRAWER_CLOSE_RATIO ||
          drag.velocityY >= PERSISTENT_DRAWER_CLOSE_VELOCITY_PX_PER_SEC);
      if (shouldClose) {
        setDragPosition(drag.height, drag.height, true);
        requestClose();
      } else {
        setDragPosition(0, drag.height, true);
      }
      event.preventDefault();
    },
    [requestClose, setDragPosition],
  );

  return createPortal(
    <>
      <div
        ref={backdropRef}
        {...portalScopeProps}
        aria-hidden="true"
        data-persistent-drawer-backdrop=""
        data-state={open ? "open" : "closed"}
        className="fixed inset-0 z-50 bg-black/40"
        style={{
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: backdropTransition,
        }}
        onClick={requestClose}
        onTouchMove={(event) => event.preventDefault()}
      />
      <div
        ref={panelRef}
        {...portalScopeProps}
        aria-hidden={!open}
        aria-labelledby={labelId}
        aria-modal={open || undefined}
        data-bb-portaled-overlay=""
        data-persistent-drawer-content=""
        data-state={open ? "open" : "closed"}
        inert={!open}
        role="dialog"
        tabIndex={-1}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 mt-24 flex max-h-[calc(92dvh-var(--bb-drawer-keyboard-inset,0px))] flex-col rounded-t-xl border bg-background pb-[var(--bb-safe-area-bottom,env(safe-area-inset-bottom))] outline-none",
          contentClassName,
        )}
        style={{
          transform: open ? "translate3d(0, 0, 0)" : "translate3d(0, 100%, 0)",
          transition,
          willChange: open ? "transform" : undefined,
        }}

      >
        <div
          data-persistent-drawer-handle=""
          className="mx-auto flex h-8 w-16 shrink-0 touch-none cursor-grab items-center justify-center active:cursor-grabbing"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={(event) => finishDrag(event, false)}
          onPointerCancel={(event) => finishDrag(event, true)}
        >
          <div className="h-1 w-10 rounded-full bg-muted-foreground/20" />
        </div>
        <h2 id={labelId} className="sr-only">{srLabel}</h2>
        {children}
      </div>
    </>,
    document.body,
  );
}
