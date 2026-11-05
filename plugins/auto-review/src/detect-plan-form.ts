import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { eventsSince, type EventOf } from "./detect-event-log.js";
import { PLAN_APPROVAL_PLUGIN_ID, PLAN_APPROVAL_RENDERER, planApprovalDescribed } from "./plan-approval-form.js";

/**
 * What a plan-approval form's resolution says. `held`: the event is
 * turn-scoped, since a form the host held is bound to the active turn while
 * one that detached is thread-scoped (bb core `pending-interaction-timeline.ts`,
 * `interactionScope`), and its answer arrives outside the turn that asked.
 * `approved`: the row's description records `approved: true`. `app`: the
 * answer reached bb through the app (`answeredVia: "app"`), not the CLI or a
 * plain API call.
 */
export interface PlanFormResolution {
  held: boolean;
  approved: boolean;
  app: boolean;
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
    interaction.payload.kind !== "plugin" ||
    interaction.origin.kind !== "plugin" ||
    interaction.origin.pluginId !== PLAN_APPROVAL_PLUGIN_ID ||
    interaction.origin.rendererId !== PLAN_APPROVAL_RENDERER ||
    interaction.status !== "resolved" ||
    resolution === null ||
    !("kind" in resolution) ||
    resolution.kind !== "plugin_submitted"
  ) {
    return null;
  }
  return {
    held: event.scope.kind === "turn",
    approved: planApprovalDescribed(resolution.description?.payload),
    // `answeredVia` is fork-only (bb core `packages/domain/src/pending-interactions.ts`,
    // the `plugin_submitted` resolution): the pinned SDK types lack it, so it is read by narrowing.
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
