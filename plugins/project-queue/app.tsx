import { toast } from "sonner";
import {
  definePluginApp,
  type ComposerSendMenuItem,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";

const PERSONAL_PROJECT_ID = "proj_personal";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cannotQueue(composer: PluginComposerApi): boolean {
  if (composer.isSubmittingBlocked) return true;
  const { scope } = composer;
  return (
    scope.kind !== "new-thread" ||
    scope.projectId === null ||
    scope.projectId === PERSONAL_PROJECT_ID
  );
}

const startWhenIdle: ComposerSendMenuItem = {
  id: "start-when-idle",
  label: "Start when project is idle",
  icon: "Clock",
  description:
    "Waits until no other thread in this project is running. Starts right away if none are.",
  disabled: cannotQueue,
  run: async ({ composer }) => {
    try {
      await composer.submit({ experimental_data: { queue: true } });
    } catch (error: unknown) {
      toast.error("Could not queue the thread", {
        description: errorMessage(error),
      });
    }
  },
};

export default definePluginApp((app) => {
  app.composer.customize({
    id: "project-queue",
    scopes: ["new-thread"],
    sendMenu: [startWhenIdle],
  });
});
