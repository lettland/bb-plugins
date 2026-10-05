import {
  type NavigationEntryLike,
  previousProjectRouteContext,
  projectRouteContext,
  type ProjectRouteContext
} from '../../project-selection.js';

export function loadSourceProjectContext(): ProjectRouteContext | null {
  const browserNavigation = (
    window as Window & {
      navigation?: {
        currentEntry?: { index: number } | null;
        entries(): NavigationEntryLike[];
      };
    }
  ).navigation;
  const currentIndex = browserNavigation?.currentEntry?.index;
  if (browserNavigation !== undefined && currentIndex !== undefined) {
    try {
      return previousProjectRouteContext(
        browserNavigation.entries(),
        currentIndex,
        window.location.origin
      );
    } catch {
      // Fall back to the document referrer when navigation history is unavailable.
    }
  }
  return projectRouteContext(document.referrer, window.location.origin);
}
