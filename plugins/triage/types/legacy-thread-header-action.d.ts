import type { ComponentType } from "react";

declare module "@get-bb/plugin-sdk/app" {
  interface PluginAppSlots {
    experimental_threadHeaderAction(registration: {
      id: string;
      title: string;
      component: ComponentType<{ threadId: string; projectId: string; isCompactViewport: boolean }>;
    }): void;
  }
}
