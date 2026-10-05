import { z } from 'zod';
import {
  bbProjectIdSchema,
  jiraBaseUrlSchema,
  secretMutationSchema
} from '../credential-contract.js';

export const workSourceSchema = z.enum(['linear', 'github', 'jira']);
export type WorkSource = z.infer<typeof workSourceSchema>;

export const trackerProjectSchema = z
  .object({
    id: bbProjectIdSchema,
    name: z.string()
  })
  .strict();
export type TrackerProject = z.infer<typeof trackerProjectSchema>;

export const projectSourceConfigSchema = z
  .object({
    projectId: bbProjectIdSchema,
    source: workSourceSchema,
    linearTeamKey: z.string().trim(),
    jiraBaseUrl: jiraBaseUrlSchema,
    jiraEmail: z.string().trim(),
    jiraJql: z.string().trim().min(1)
  })
  .strict();
export type ProjectSourceConfig = z.infer<typeof projectSourceConfigSchema>;

export const projectConfigViewSchema = projectSourceConfigSchema
  .extend({
    githubRepos: z.array(z.string()),
    linearCredentialConfigured: z.boolean(),
    jiraCredentialConfigured: z.boolean()
  })
  .strict();
export type ProjectConfigView = z.infer<typeof projectConfigViewSchema>;

export const projectConfigMutationSchema = projectSourceConfigSchema
  .extend({
    linearCredential: secretMutationSchema,
    jiraCredential: secretMutationSchema
  })
  .strict()
  .superRefine((config, context) => {
    if (config.source === 'linear' && !config.linearTeamKey) {
      context.addIssue({
        code: 'custom',
        path: ['linearTeamKey'],
        message: 'Linear team key is required when Linear is selected'
      });
    }
  });
export type ProjectConfigMutation = z.infer<typeof projectConfigMutationSchema>;

export const workStateCategorySchema = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'done',
  'canceled'
]);
export type WorkStateCategory = z.infer<typeof workStateCategorySchema>;

export const workStatusOptionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    stateCategory: workStateCategorySchema,
    current: z.boolean()
  })
  .strict();
export type WorkStatusOption = z.infer<typeof workStatusOptionSchema>;

export const workItemSchema = z
  .object({
    bbProjectId: bbProjectIdSchema,
    source: workSourceSchema,
    locator: z.string().min(1),
    key: z.string().min(1),
    title: z.string(),
    description: z.string(),
    url: z.string(),
    status: z.string(),
    stateCategory: workStateCategorySchema,
    priority: z.string().nullable(),
    assignee: z.string().nullable(),
    project: z.string().nullable(),
    labels: z.array(z.string()),
    updatedAt: z.string()
  })
  .strict();
export type WorkItem = z.infer<typeof workItemSchema>;

export const workCommentSchema = z
  .object({
    author: z.string(),
    body: z.string(),
    createdAt: z.string()
  })
  .strict();

export const workItemDetailSchema = workItemSchema
  .extend({ comments: z.array(workCommentSchema) })
  .strict();
export type WorkItemDetail = z.infer<typeof workItemDetailSchema>;

export const workSourceStatusSchema = z
  .object({
    source: workSourceSchema,
    configured: z.boolean(),
    available: z.boolean(),
    message: z.string().nullable(),
    lastSyncedAt: z.string().nullable(),
    itemCount: z.number().int().nonnegative()
  })
  .strict();
export type WorkSourceStatus = z.infer<typeof workSourceStatusSchema>;
