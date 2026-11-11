import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPlanApprovalPayload, PLAN_APPROVAL_PAYLOAD_BUDGET_BYTES } from "./plan-approval-payload.js";
import { planApprovalPayloadSchema, type PlanApprovalPayload } from "./plan-approval-form.js";

const PATH = "/w/docs/plans/p.md";
const bytesOf = (payload: PlanApprovalPayload) => Buffer.byteLength(JSON.stringify(payload), "utf8");
const build = (text: string) => buildPlanApprovalPayload({ planFilePath: PATH, reviewed: true, bytes: Buffer.from(text, "utf8") });
const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** The bytes of the payload with an empty text: what the other fields cost. */
const overhead = bytesOf({ planFilePath: PATH, reviewed: true, planText: "", planSha256: sha(""), truncated: true });

describe("buildPlanApprovalPayload", () => {
  it("shows a short plan whole, with the hash of the file", () => {
    const payload = build("# Plan\n\nstep 1\n");
    expect(payload).toEqual({ planFilePath: PATH, reviewed: true, planText: "# Plan\n\nstep 1\n", planSha256: sha("# Plan\n\nstep 1\n"), truncated: false });
    expect(planApprovalPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("has no text and no hash for a plan this host cannot read", () => {
    const payload = buildPlanApprovalPayload({ planFilePath: PATH, reviewed: false, bytes: null });
    expect(payload).toEqual({ planFilePath: PATH, reviewed: false, planText: null, planSha256: null, truncated: false });
    expect(planApprovalPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("hashes the file's bytes, not the cut text", () => {
    const text = "x".repeat(PLAN_APPROVAL_PAYLOAD_BUDGET_BYTES * 2);
    expect(build(text).planSha256).toBe(sha(text));
  });

  // `"truncated":false` is one byte longer than `"truncated":true`, so a whole plan has one byte less room than a cut one.
  const wholeFill = PLAN_APPROVAL_PAYLOAD_BUDGET_BYTES - overhead - 1;

  it("keeps a plan that fills the budget exactly whole", () => {
    const text = "a".repeat(wholeFill);
    const payload = build(text);
    expect(bytesOf(payload)).toBe(PLAN_APPROVAL_PAYLOAD_BUDGET_BYTES);
    expect(payload.truncated).toBe(false);
    expect(payload.planText).toBe(text);
  });

  it.each([2, 500])("cuts a plan %i code points over the budget, to the longest prefix that fits", (extra) => {
    const payload = build("a".repeat(wholeFill + extra));
    expect(payload.truncated).toBe(true);
    expect(bytesOf(payload)).toBe(PLAN_APPROVAL_PAYLOAD_BUDGET_BYTES);
    expect(bytesOf({ ...payload, planText: `${payload.planText}a` })).toBeGreaterThan(PLAN_APPROVAL_PAYLOAD_BUDGET_BYTES);
  });

  it("never marks a whole text as truncated: one code point over the whole-text limit still cuts one", () => {
    const payload = build("a".repeat(wholeFill + 1));
    expect(payload.truncated).toBe(true);
    expect(payload.planText).toBe("a".repeat(wholeFill));
  });

  const samples: [string, string][] = [
    ["CJK text (3 bytes per character)", "计划步骤：实现功能。".repeat(8000)],
    ["emoji (4 bytes, a surrogate pair each)", "🚀📋✅".repeat(9000)],
    ["escape-heavy text (quotes, backslashes, control characters)", '"\\\n\t\u0001"'.repeat(12000)],
    ["mixed text", "plan: ünïcode 计划 🚀 \"quoted\" \\ back\n".repeat(3000)],
  ];

  it.each(samples)("stays within the budget in serialized UTF-8 bytes for %s, cut at a code point", (_name, text) => {
    const payload = build(text);
    expect(payload.truncated).toBe(true);
    expect(bytesOf(payload)).toBeLessThanOrEqual(PLAN_APPROVAL_PAYLOAD_BUDGET_BYTES);
    const shown = payload.planText!;
    expect(text.startsWith(shown)).toBe(true);
    // No lone surrogate: the cut did not split a pair.
    expect(shown).toBe(Buffer.from(shown, "utf8").toString("utf8"));
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(shown)).toBe(false);
    // The longest prefix: one more code point would not fit.
    const next = Array.from(text.slice(shown.length))[0]!;
    expect(bytesOf({ ...payload, planText: `${shown}${next}` })).toBeGreaterThan(PLAN_APPROVAL_PAYLOAD_BUDGET_BYTES);
    expect(payload.planSha256).toBe(sha(text));
  });

  it("measures bytes, not string length: a plan of 30000 CJK characters is over the budget though under 60 KiB long", () => {
    const text = "计".repeat(30000);
    expect(text.length).toBeLessThan(PLAN_APPROVAL_PAYLOAD_BUDGET_BYTES);
    expect(build(text).truncated).toBe(true);
  });
});

