import { createHash } from "node:crypto";
import type { PlanApprovalPayload } from "./plan-approval-form.js";

/**
 * Builds the plan approval form's payload. Server-side only: `plan-approval-form.ts`
 * is also bundled into the app, which has no `node:crypto` and no `Buffer`.
 */

/**
 * The most bytes the payload may take: `JSON.stringify(payload)` encoded as
 * UTF-8, which is how core measures it against its 64 KiB
 * `PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES`, so JSON escaping and multi-byte text
 * count. The headroom under that limit is for the other fields.
 */
export const PLAN_APPROVAL_PAYLOAD_BUDGET_BYTES = 60 * 1024;

/** The hex SHA-256 of a plan file's bytes: what the form binds an approval to. */
export function planSha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function payloadBytes(payload: PlanApprovalPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

/**
 * The payload for a plan file read as `bytes`, or for a file this host cannot
 * read (`bytes` null). The text is whole when the serialized payload fits the
 * budget; otherwise it is the longest prefix, cut between code points, that
 * fits, and `truncated` is set. The hash always covers the whole file.
 */
export function buildPlanApprovalPayload(input: {
  planFilePath: string;
  reviewed: boolean;
  bytes: Buffer | null;
}): PlanApprovalPayload {
  const { planFilePath, reviewed, bytes } = input;
  if (bytes === null) {
    return { planFilePath, reviewed, planText: null, planSha256: null, truncated: false };
  }
  const planSha256 = planSha256Of(bytes);
  const text = bytes.toString("utf8");
  const whole: PlanApprovalPayload = { planFilePath, reviewed, planText: text, planSha256, truncated: false };
  if (payloadBytes(whole) <= PLAN_APPROVAL_PAYLOAD_BUDGET_BYTES) {
    return whole;
  }
  const points = Array.from(text);
  const prefix = (count: number): PlanApprovalPayload => ({
    planFilePath,
    reviewed,
    planText: points.slice(0, count).join(""),
    planSha256,
    truncated: true,
  });
  // The serialized size never shrinks as the prefix grows, so the longest fitting prefix is found by bisection.
  let fits = 0;
  let over = points.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (payloadBytes(prefix(middle)) <= PLAN_APPROVAL_PAYLOAD_BUDGET_BYTES) {
      fits = middle;
    } else {
      over = middle;
    }
  }
  return prefix(fits);
}

