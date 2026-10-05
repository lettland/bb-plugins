import { Buffer } from 'node:buffer';

export interface JiraAuth {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const hasExplicitPort = /^https:\/\/[^/?#]+:\d+(?:[/?#]|$)/iu.test(trimmed);
    if (
      parsed.protocol !== 'https:' ||
      !(
        parsed.hostname === 'atlassian.net' ||
        parsed.hostname.endsWith('.atlassian.net')
      ) ||
      parsed.username ||
      parsed.password ||
      hasExplicitPort ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    ) {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

export async function jiraRequest(
  options: JiraAuth,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      ...init,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`,
        ...(init?.body === undefined
          ? {}
          : { 'content-type': 'application/json' })
      },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error('Could not reach Jira');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Jira returned HTTP ${response.status}`);
  return payload;
}
