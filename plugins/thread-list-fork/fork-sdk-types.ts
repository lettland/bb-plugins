import type {
  PluginSidebarThreadIndicator as PublishedPluginSidebarThreadIndicator,
  PluginThreadStatus as PublishedPluginThreadStatus,
} from "@get-bb/plugin-sdk/app";

export type PluginSidebarThreadIndicator =
  | PublishedPluginSidebarThreadIndicator
  | "waiting-for-plan-approval"
  | "waiting-for-answer";

export type ForkThreadStatus = Omit<
  PublishedPluginThreadStatus,
  "indicator"
> & {
  indicator: PluginSidebarThreadIndicator;
};
