import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { eventsSince, type EventOf } from "./detect-event-log.js";
import {
  PLAN_APPROVAL_PLUGIN_ID,
  PLAN_APPROVAL_RENDERER,
  planApprovalChanged,
  planApprovalDescribed,
} from "./plan-approval-form.js";

/**
 * What a plan-approval form's resolution says. `held`: the host held the form
 * for the turn that asked, which shows two ways. The event is turn-scoped
 * (a form bound to the active turn); or the resolution carries `heldTurnId`,
 * which core writes on the answer to a form it held inside a turn, also after
 * the form detached from that turn (bb core `experimental_detachOnAbort`) and
 * its event became thread-scoped. A form a host without the hold detached has
 * neither. `detached`: held through `heldTurnId` while the event is
 * thread-scoped, so the answer arrived outside the turn that asked and the turn
 * its message starts is the one that counts it (`endedTurn`).
 * `approved`: the row's description records `approved: true`. `planChanged`:
 * the description records an approval that did not count because the plan file
 * changed after the form opened (`approved` is then false). `app`: the answer
 * reached bb through the app (`answeredVia: "app"`), not the CLI or a plain API
 * call.
 *
 * `app` is a deterrent, not a guarantee. It rests on the `x-bb-app-surface`
 * request header, which the client declares about itself, so a caller with bb
 * API access that sends the header is recorded as an app answer. A detached form
 * stays open for up to its whole timeout while the agent can start new turns,
 * which widens that window. Nothing here proves the user pressed the button.
 */
export interface PlanFormResolution {
  held: boolean;
  detached: boolean;
  approved: boolean;
  planChanged: boolean;
  app: boolean;
}

/** Whether the interaction is this plugin's plan-approval form, in whatever state. */
export function isPlanFormInteraction(interaction: EventOf<"system/interaction/lifecycle">["data"]["interaction"]): boolean {
  return (
    interaction.payload.kind === "plugin" &&
    interaction.origin.kind === "plugin" &&
    interaction.origin.pluginId === PLAN_APPROVAL_PLUGIN_ID &&
    interaction.origin.rendererId === PLAN_APPROVAL_RENDERER
  );
}

/**
 * How the lifecycle event resolved this plugin's plan-approval form, or null
 * when it is not that form resolved by a submission: the interaction is
 * `auto-review`'s `plan-approval`, `resolved`, `plugin_submitted`. A native
 * approval's payload is not a plugin payload, so its events are rejected
 * before their origin is read.
 */
export function planFormResolution(event: EventOf<"system/interaction/lifecycle">): PlanFormResolution | null {
  const { interaction } = event.data;
  const { resolution } = interaction;
  if (
    !isPlanFormInteraction(interaction) ||
    interaction.status !== "resolved" ||
    resolution === null ||
    !("kind" in resolution) ||
    resolution.kind !== "plugin_submitted"
  ) {
    return null;
  }
  // `answeredVia` and `heldTurnId` are fork-only (bb core `packages/domain/src/pending-interactions.ts`,
  // the `plugin_submitted` resolution): @get-bb/plugin-sdk 0.6.79 (the pinned version) lacks both, so they are read by narrowing;
  // drop the narrowing once a pinned SDK types them. Only core writes `heldTurnId`.
  const heldTurnId = "heldTurnId" in resolution && typeof resolution.heldTurnId === "string" && resolution.heldTurnId !== "";
  const turnScoped = event.scope.kind === "turn";
  return {
    held: turnScoped || heldTurnId,
    detached: !turnScoped && heldTurnId,
    approved: planApprovalDescribed(resolution.description?.payload),
    planChanged: planApprovalChanged(resolution.description?.payload),
    // Absent, `"api"` and any other value are not an app answer.
    app: "answeredVia" in resolution && resolution.answeredVia === "app",
  };
}

/**
 * The latest resolution of this plugin's plan-approval form after the cursor,
 * or null when there is none. `PresentPlan` reads it once the form settles, to
 * tell a form the host held from one that detached, and an approval the gate
 * will credit from one it will not.
 */
export async function planFormResolutionSince(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<PlanFormResolution | null> {
  let latest: PlanFormResolution | null = null;
  for await (const event of eventsSince(bb, threadId, sinceSeq, "system/interaction/lifecycle")) {
    latest = planFormResolution(event) ?? latest;
  }
  return latest;
}
