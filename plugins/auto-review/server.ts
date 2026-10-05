import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerAutoReviewCli } from "./src/cli.js";
import { createReviewContext } from "./src/context.js";
import { registerLifecycleEvents } from "./src/lifecycle-events.js";
import { registerPlanGateEvents } from "./src/plan-gate.js";
import { registerPlanTools } from "./src/present-plan.js";
import { registerTurnEvents } from "./src/turn-events.js";

export default async function plugin(bb: BbPluginApi) {
  const ctx = await createReviewContext(bb);
  registerPlanTools(ctx);
  registerPlanGateEvents(ctx);
  registerTurnEvents(ctx);
  registerLifecycleEvents(ctx);
  registerAutoReviewCli(bb, ctx.settings, () => ctx.globals);
}
