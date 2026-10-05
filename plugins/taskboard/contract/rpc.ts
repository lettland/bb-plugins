import type { PluginRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { projectBoardSettingsSchema } from '../board-settings.js';
import { bbProjectIdSchema } from '../credential-contract.js';
import {
  FILTER_PRESET_LIMIT,
  filterPresetIdSchema,
  filterPresetNameSchema,
  filterPresetOrderSchema,
  filterPresetProjectIdSchema,
  filterPresetSchema,
  filterPresetSummarySchema,
  filterPresetStateSchema
} from '../filter-presets.js';
import {
  assigneeConfirmationSchema,
  connectorRevisionSchema,
  createIssueContextSchema,
  createIssueInputSchema,
  createIssueMetadataFailureSchema,
  createIssueMetadataSchema
} from './create-issue.js';
import {
  projectConfigMutationSchema,
  projectConfigViewSchema,
  trackerProjectSchema,
  workItemDetailSchema,
  workItemSchema,
  workSourceSchema,
  workSourceStatusSchema,
  workStateCategorySchema,
  workStatusOptionSchema
} from './work.js';

const listInputSchema = z
  .object({
    projectId: bbProjectIdSchema.optional(),
    source: workSourceSchema.optional(),
    query: z.string().optional(),
    stateCategories: z.array(workStateCategorySchema).optional(),
    limit: z.number().int().min(1).max(500).default(200)
  })
  .strict();

export const taskboardRpcContract = {
  listProjects: {
    input: z.null(),
    output: z.object({ projects: z.array(trackerProjectSchema) }).strict()
  },
  threadProject: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ projectId: bbProjectIdSchema }).strict()
  },
  status: {
    input: z.object({ projectId: bbProjectIdSchema }).strict(),
    output: z.object({ sources: z.array(workSourceStatusSchema) }).strict()
  },
  listItems: {
    input: listInputSchema,
    output: z
      .object({
        items: z.array(workItemSchema),
        provider: workSourceSchema.nullable()
      })
      .strict()
  },
  refresh: {
    input: z
      .object({
        projectId: bbProjectIdSchema,
        source: workSourceSchema.optional()
      })
      .strict(),
    output: z
      .object({
        sources: z.array(workSourceStatusSchema),
        itemCount: z.number().int().nonnegative()
      })
      .strict()
  },
  getItem: {
    input: z
      .object({
        projectId: bbProjectIdSchema,
        source: workSourceSchema,
        locator: z.string().min(1)
      })
      .strict(),
    output: z.object({ item: workItemDetailSchema }).strict()
  },
  statusOptions: {
    input: z
      .object({
        projectId: bbProjectIdSchema,
        source: workSourceSchema,
        locator: z.string().min(1)
      })
      .strict(),
    output: z.object({ options: z.array(workStatusOptionSchema) }).strict()
  },
  updateItemStatus: {
    input: z
      .object({
        projectId: bbProjectIdSchema,
        source: workSourceSchema,
        locator: z.string().min(1),
        statusId: z.string().min(1)
      })
      .strict(),
    output: z.object({ item: workItemSchema }).strict()
  },
  getCreateIssueContext: {
    input: z.object({ projectId: bbProjectIdSchema }).strict(),
    output: z.object({ context: createIssueContextSchema }).strict()
  },
  getCreateIssueMetadata: {
    input: z
      .object({
        projectId: bbProjectIdSchema,
        expectedSource: workSourceSchema,
        destinationId: z.string().trim().min(1).max(500),
        issueType: z.string().trim().min(1).max(100).nullable()
      })
      .strict(),
    output: z.discriminatedUnion('ok', [
      z
        .object({
          ok: z.literal(true),
          metadata: createIssueMetadataSchema,
          connectorRevision: connectorRevisionSchema
        })
        .strict(),
      createIssueMetadataFailureSchema
    ])
  },
  createIssue: {
    input: createIssueInputSchema,
    output: z
      .object({
        item: workItemSchema,
        warnings: z.array(z.string()),
        assigneeConfirmation: assigneeConfirmationSchema,
        mention: z
          .object({
            provider: z.literal('external-work-item'),
            id: z.string().min(1),
            label: z.string().min(1)
          })
          .strict()
      })
      .strict()
  },
  getProjectConfig: {
    input: z.object({ projectId: bbProjectIdSchema }).strict(),
    output: z.object({ config: projectConfigViewSchema }).strict()
  },
  saveProjectConfig: {
    input: projectConfigMutationSchema,
    output: z.object({ config: projectConfigViewSchema }).strict()
  },
  getProjectBoardSettings: {
    input: z.object({ projectId: bbProjectIdSchema }).strict(),
    output: z.object({ settings: projectBoardSettingsSchema }).strict()
  },
  saveProjectBoardSettings: {
    input: projectBoardSettingsSchema,
    output: z.object({ settings: projectBoardSettingsSchema }).strict()
  },
  listFilterPresets: {
    input: z.object({ projectId: filterPresetProjectIdSchema }).strict(),
    output: z
      .object({
        presets: z.array(filterPresetSchema).max(FILTER_PRESET_LIMIT)
      })
      .strict()
  },
  saveFilterPreset: {
    input: z
      .object({
        projectId: filterPresetProjectIdSchema,
        id: filterPresetIdSchema.optional(),
        name: filterPresetNameSchema,
        state: filterPresetStateSchema
      })
      .strict(),
    output: z
      .object({
        preset: filterPresetSummarySchema,
        presets: z.array(filterPresetSchema).max(FILTER_PRESET_LIMIT)
      })
      .strict()
  },
  deleteFilterPreset: {
    input: z
      .object({
        projectId: filterPresetProjectIdSchema,
        id: filterPresetIdSchema
      })
      .strict(),
    output: z
      .object({
        presets: z.array(filterPresetSchema).max(FILTER_PRESET_LIMIT)
      })
      .strict()
  },
  reorderFilterPresets: {
    input: z
      .object({
        projectId: filterPresetProjectIdSchema,
        ids: filterPresetOrderSchema
      })
      .strict(),
    output: z
      .object({
        presets: z.array(filterPresetSchema).max(FILTER_PRESET_LIMIT)
      })
      .strict()
  }
} satisfies PluginRpcContract;

export type TaskboardRpcContract = typeof taskboardRpcContract;
