import { type WorkSource } from '../../contract.js';

export type TrackerRoute =
  | { kind: 'root' }
  | { kind: 'all' }
  | { kind: 'project'; projectId: string }
  | { kind: 'manage'; projectId: string | null }
  | {
      kind: 'item';
      projectId: string;
      source: WorkSource;
      locator: string;
    };

function encodeLocator(locator: string): string {
  // encodeURIComponent deliberately leaves "~" untouched, but this route uses
  // it as the percent-escape marker. Escape literal tildes first so arbitrary
  // external locators still round-trip without colliding with that marker.
  return encodeURIComponent(locator)
    .replaceAll('~', '%7E')
    .replaceAll('%', '~');
}

function decodeLocator(locator: string): string {
  try {
    return decodeURIComponent(locator.replaceAll('~', '%'));
  } catch {
    return '';
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isWorkSource(value: string): value is WorkSource {
  return value === 'linear' || value === 'github' || value === 'jira';
}

export function parseTrackerRoute(rawSubPath: string): TrackerRoute {
  const path = rawSubPath.split('?', 1)[0] ?? '';
  const segments = path.split('/').filter(Boolean);
  const head = segments[0];
  if (head === undefined) return { kind: 'root' };
  if (head === 'all') return { kind: 'all' };
  if (head === 'manage') {
    return {
      kind: 'manage',
      projectId: segments[1] ? decodeSegment(segments[1]) : null
    };
  }
  if (head === 'item') {
    const projectId = segments[1];
    const source = segments[2];
    const encodedLocator = segments[3];
    if (projectId && source && isWorkSource(source) && encodedLocator) {
      const locator = decodeLocator(encodedLocator);
      if (locator) {
        return {
          kind: 'item',
          projectId: decodeSegment(projectId),
          source,
          locator
        };
      }
    }
    return { kind: 'all' };
  }
  return { kind: 'project', projectId: decodeSegment(head) };
}

export function routeToSubPath(route: TrackerRoute): string {
  switch (route.kind) {
    case 'root':
      return '';
    case 'all':
      return 'all';
    case 'manage':
      return route.projectId
        ? `manage/${encodeURIComponent(route.projectId)}`
        : 'manage';
    case 'project':
      return encodeURIComponent(route.projectId);
    case 'item':
      return `item/${encodeURIComponent(route.projectId)}/${route.source}/${encodeLocator(route.locator)}`;
  }
}
