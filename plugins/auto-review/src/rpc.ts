import { effectiveConfig, readProjectConfig, setAutoApprovePlans } from "./config.js";
import type { ReviewContext } from "./context.js";
import { readFindings } from "./findings-store.js";
import { summarizeReview } from "./findings.js";
import { autoReviewRpcContract } from "./rpc-contract.js";
import { readState, REVIEW_IN_FLIGHT_PHASES } from "./state.js";

async function listProjects(ctx: ReviewContext) {
  const projects = await ctx.bb.sdk.projects.list({ includePersonal: true });
  return projects
    .map((project) => ({ id: project.id, name: project.name }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** Not discoverable: these methods exist for the settings page, not for agents. */
export function registerAutoReviewRpc(ctx: ReviewContext): void {
  const { bb } = ctx;
  bb.rpc.register(autoReviewRpcContract, {
    async listProjectSettings() {
      const projects = await listProjects(ctx);
      const rows = await Promise.all(
        projects.map(async (project) => {
          const config = await readProjectConfig(bb, project.id);
          return {
            ...project,
            autoApprovePlans: config.autoApprovePlans ?? false,
            reviewActive: effectiveConfig(ctx.globals, config).enabled,
          };
        }),
      );
      return { projects: rows };
    },
    async threadReview(input) {
      const [store, state] = await Promise.all([
        readFindings(bb, input.threadId),
        readState(bb, input.threadId),
      ]);
      return summarizeReview(store, REVIEW_IN_FLIGHT_PHASES.includes(state.phase));
    },
    async setAutoApprovePlans(input) {
      const projects = await listProjects(ctx);
      if (!projects.some((project) => project.id === input.projectId)) {
        throw new Error("BB project was not found");
      }
      await setAutoApprovePlans(bb, input.projectId, input.autoApprovePlans, "rpc");
      const stored = await readProjectConfig(bb, input.projectId);
      return {
        projectId: input.projectId,
        // v8 ignore next -- @preserve the setter above always stores a boolean, so the read-back never misses the key.
        autoApprovePlans: stored.autoApprovePlans ?? false,
      };
    },
  });
}
