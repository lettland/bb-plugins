import { z } from 'zod';

// aislop-ignore-next-line ai-slop/hardcoded-url -- fixed public API endpoint
const LINEAR_API = 'https://api.linear.app/graphql';

export async function requestLinear(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(LINEAR_API, {
      method: 'POST',
      headers: {
        authorization: apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error('Could not reach Linear');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Linear returned HTTP ${response.status}`);
  const envelope = z
    .object({
      data: z.unknown().optional(),
      errors: z.array(z.unknown()).optional()
    })
    .passthrough()
    .parse(payload);
  if (envelope.errors && envelope.errors.length > 0) {
    throw new Error('Linear rejected the request');
  }
  return envelope.data;
}
