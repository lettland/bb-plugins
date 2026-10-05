import { useEffect, useRef } from 'react';
import { useRealtimeConnectionState } from '@get-bb/plugin-sdk/app';

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function changedProjectId(payload: unknown): string | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('projectId' in payload) ||
    typeof payload.projectId !== 'string'
  ) {
    return null;
  }
  return payload.projectId;
}

export function useRefreshOnReconnect(refresh: () => void): void {
  const connectionState = useRealtimeConnectionState();
  const previousStateRef = useRef(connectionState);
  // "reconnecting" proves this shared socket connected before this component
  // mounted; only "connecting" is the initial, never-connected state.
  const hasConnectedRef = useRef(connectionState !== 'connecting');
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (
      connectionState === 'connected' &&
      hasConnectedRef.current &&
      previousStateRef.current !== 'connected'
    ) {
      refreshRef.current();
    }
    if (connectionState === 'connected') hasConnectedRef.current = true;
    previousStateRef.current = connectionState;
  }, [connectionState]);
}

export function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric'
  }).format(new Date(timestamp));
}
