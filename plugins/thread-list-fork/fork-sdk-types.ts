import type { ComponentType } from "react";
import type {
  PluginSidebarThreadIndicator as PublishedPluginSidebarThreadIndicator,
  PluginThreadStatusGlyphProps as PublishedPluginThreadStatusGlyphProps,
} from "@get-bb/plugin-sdk/app";

export type PluginSidebarThreadIndicator =
  | PublishedPluginSidebarThreadIndicator
  | "waiting-for-plan-approval"
  | "waiting-for-answer";

export type ForkThreadStatusGlyph = ComponentType<
  Omit<PublishedPluginThreadStatusGlyphProps, "indicator"> & {
    indicator: PluginSidebarThreadIndicator;
  }
>;
