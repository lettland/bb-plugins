import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH
} from './constants.js';

export const RIGHT_PANEL_PINNED_STORAGE_KEY = 'bb-taskboard:right-panel-pinned';
export const RIGHT_PANEL_PIN_EVENT = 'bb-taskboard:right-panel-pin-changed';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'bb-taskboard:sidebar-collapsed';
const SIDEBAR_WIDTH_STORAGE_KEY = 'bb-taskboard:sidebar-width';
const LAST_PROJECT_STORAGE_KEY = 'bb-taskboard:last-project';

export function loadLastProjectId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeLastProjectId(projectId: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // Persistence is best-effort in sandboxed browser contexts.
  }
}

export function loadRightPanelPinned(): boolean {
  try {
    return (
      window.localStorage.getItem(RIGHT_PANEL_PINNED_STORAGE_KEY) === 'true'
    );
  } catch {
    return false;
  }
}

export function storeRightPanelPinned(pinned: boolean): void {
  try {
    window.localStorage.setItem(
      RIGHT_PANEL_PINNED_STORAGE_KEY,
      String(pinned)
    );
    window.dispatchEvent(new Event(RIGHT_PANEL_PIN_EVENT));
  } catch {
    // Persistence is best-effort in sandboxed browser contexts.
  }
}

export function loadSidebarCollapsed(): boolean {
  try {
    return (
      window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'
    );
  } catch {
    return false;
  }
}

export function storeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      String(collapsed)
    );
  } catch {
    // Persistence is best-effort in sandboxed browser contexts.
  }
}

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

export function loadSidebarWidth(): number {
  try {
    const stored = Number(
      window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    );
    return Number.isFinite(stored) && stored > 0
      ? clampSidebarWidth(stored)
      : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function storeSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Persistence is best-effort in sandboxed browser contexts.
  }
}
