import { z } from 'zod';
import { bbProjectIdSchema } from '../credential-contract.js';
import { workSourceSchema } from './work.js';

export const createIssueDestinationSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1)
  })
  .strict();
export type CreateIssueDestination = z.infer<
  typeof createIssueDestinationSchema
>;

export const createIssueOptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1)
  })
  .strict();
export type CreateIssueOption = z.infer<typeof createIssueOptionSchema>;

export const createIssueMetadataSchema = z
  .object({
    statusOptions: z.array(createIssueOptionSchema),
    assigneeOptions: z.array(createIssueOptionSchema),
    priorityOptions: z.array(createIssueOptionSchema),
    labelOptions: z.array(createIssueOptionSchema),
    milestoneOptions: z.array(createIssueOptionSchema),
    issueTypeOptions: z.array(createIssueOptionSchema),
    defaultStatusId: z.string().nullable(),
    defaultIssueTypeId: z.string().nullable(),
    supportsDueDate: z.boolean()
  })
  .strict();
export type CreateIssueMetadata = z.infer<typeof createIssueMetadataSchema>;

export const createIssueMetadataFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.literal('metadata_unavailable'),
        safeMessage: z.string().min(1).max(500)
      })
      .strict()
  })
  .strict();
export type CreateIssueMetadataFailure = z.infer<
  typeof createIssueMetadataFailureSchema
>;

export const assigneeConfirmationSchema = z.discriminatedUnion('confirmed', [
  z
    .object({
      confirmed: z.literal(true),
      id: z.string().min(1).max(500).nullable()
    })
    .strict(),
  z.object({ confirmed: z.literal(false) }).strict()
]);
export type AssigneeConfirmation = z.infer<
  typeof assigneeConfirmationSchema
>;

export const connectorRevisionSchema = z.number().int().nonnegative();
export const CREATE_OUTCOME_UNCERTAIN_MARKER =
  '[TASKBOARD_CREATE_OUTCOME_UNCERTAIN]';

export const createIssueContextSchema = z
  .object({
    projectId: bbProjectIdSchema,
    projectName: z.string().min(1),
    source: workSourceSchema,
    available: z.boolean(),
    message: z.string().nullable(),
    destinationLabel: z.enum(['Repository', 'Team', 'Project key']),
    destinations: z.array(createIssueDestinationSchema),
    defaultDestinationId: z.string().nullable(),
    allowsCustomDestination: z.boolean(),
    defaultIssueType: z.string().nullable()
  })
  .strict();
export type CreateIssueContext = z.infer<typeof createIssueContextSchema>;

export const createIssueInputSchema = z
  .object({
    projectId: bbProjectIdSchema,
    expectedSource: workSourceSchema,
    connectorRevision: connectorRevisionSchema,
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).default(''),
    destinationId: z.string().trim().min(1).max(500),
    issueType: z.string().trim().min(1).max(100).nullable().default(null),
    statusId: z.string().trim().min(1).max(500).nullable().default(null),
    assigneeId: z.string().trim().min(1).max(500).nullable().default(null),
    priorityId: z.string().trim().min(1).max(500).nullable().default(null),
    labelIds: z.array(z.string().min(1).max(500)).max(100).default([]),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .nullable()
      .default(null),
    milestoneId: z.string().trim().min(1).max(500).nullable().default(null)
  })
  .strict();
export type CreateIssueInput = z.infer<typeof createIssueInputSchema>;
