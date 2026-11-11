import { describe, expect, it } from "vitest";
import {
  planApprovalChanged,
  planApprovalDescribed,
  planApprovalDescription,
  planApprovalPayloadSchema,
  parsePlanApprovalValue,
  PLAN_CHANGED_TITLE,
} from "./plan-approval-form.js";

const PATH = "/w/docs/plans/p.md";

describe("planApprovalDescription", () => {
  const approve = parsePlanApprovalValue({ approved: true });

  it("records an approval whose plan changed as not approved, with its own title", () => {
    expect(planApprovalDescription(approve, true)).toEqual({ title: PLAN_CHANGED_TITLE, payload: { approved: false, planChanged: true } });
    expect(PLAN_CHANGED_TITLE).toBe("Not counted: the plan changed after the form opened");
  });

  it("records the other answers as before when the plan did not change", () => {
    expect(planApprovalDescription(approve)).toEqual({ title: "Approved", payload: { approved: true } });
    expect(planApprovalDescription(parsePlanApprovalValue({ approved: false }))).toEqual({ title: "Changes requested", payload: { approved: false } });
    expect(planApprovalDescription(parsePlanApprovalValue("x"))).toEqual({ title: "Answer not readable", payload: { approved: false } });
  });

  it("reads a described payload back: approved only for approved true, planChanged only for planChanged true", () => {
    expect(planApprovalDescribed({ approved: true })).toBe(true);
    expect(planApprovalDescribed({ approved: false, planChanged: true })).toBe(false);
    expect(planApprovalChanged({ approved: false, planChanged: true })).toBe(true);
    expect(planApprovalChanged({ approved: true })).toBe(false);
    expect(planApprovalChanged({ approved: false, planChanged: false })).toBe(false);
    expect(planApprovalChanged("garbage")).toBe(false);
  });
});

describe("planApprovalPayloadSchema", () => {
  it.each([
    ["a payload from before the plan text was shown", { planFilePath: PATH, reviewed: true }],
    ["a missing hash", { planFilePath: PATH, reviewed: true, planText: "x", truncated: false }],
    ["a non-boolean truncated", { planFilePath: PATH, reviewed: true, planText: "x", planSha256: "h", truncated: "no" }],
  ])("rejects %s", (_name, payload) => {
    expect(planApprovalPayloadSchema.safeParse(payload).success).toBe(false);
  });
});
