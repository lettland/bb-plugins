import { z } from 'zod';

export const jiraIssueSchema = z
  .object({
    id: z.string().regex(/^[1-9]\d*$/),
    key: z.string().min(1),
    fields: z
      .object({
        summary: z.string(),
        description: z.unknown().nullable().optional(),
        updated: z.string(),
        status: z
          .object({
            id: z.string().min(1),
            name: z.string(),
            statusCategory: z.object({ key: z.string() }).passthrough()
          })
          .passthrough(),
        priority: z.object({ name: z.string() }).passthrough().nullable(),
        assignee: z
          .object({
            accountId: z.string().min(1).optional(),
            displayName: z.string()
          })
          .passthrough()
          .nullable(),
        project: z.object({ key: z.string(), name: z.string() }).passthrough(),
        labels: z.array(z.string()),
        comment: z
          .object({
            comments: z.array(
              z
                .object({
                  body: z.unknown(),
                  created: z.string(),
                  author: z.object({ displayName: z.string() }).passthrough()
                })
                .passthrough()
            )
          })
          .passthrough()
          .optional()
      })
      .passthrough()
  })
  .passthrough();

export const jiraSearchPageSchema = z
  .object({
    issues: z.array(jiraIssueSchema),
    nextPageToken: z.string().nullable().optional()
  })
  .passthrough();

export const jiraJqlMatchSchema = z
  .object({
    matches: z
      .array(
        z
          .object({
            matchedIssues: z.array(z.number().int().positive()),
            errors: z.array(z.string())
          })
          .passthrough()
      )
      .length(1)
  })
  .passthrough();

export const jiraTransitionsSchema = z
  .object({
    transitions: z.array(
      z
        .object({
          id: z.string().min(1),
          to: z
            .object({
              id: z.string().min(1),
              name: z.string().min(1),
              statusCategory: z.object({ key: z.string() }).passthrough()
            })
            .passthrough()
        })
        .passthrough()
    )
  })
  .passthrough();

export const jiraCreatedIssueSchema = z
  .object({
    id: z.string().regex(/^[1-9]\d*$/),
    key: z.string().min(1),
    self: z.string().optional()
  })
  .passthrough();

export const jiraCreateIssueTypesSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    maxResults: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    issueTypes: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          subtask: z.boolean().default(false)
        })
        .passthrough()
    )
  })
  .passthrough();

export const jiraCreateFieldsSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    maxResults: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    fields: z.array(
      z
        .object({
          fieldId: z.string().min(1),
          allowedValues: z.array(z.unknown()).optional()
        })
        .passthrough()
    )
  })
  .passthrough();

export const jiraAssignableUserSchema = z
  .object({
    accountId: z.string().min(1),
    displayName: z.string().min(1),
    active: z.boolean().optional()
  })
  .passthrough();
export const jiraAssignableUsersSchema = z.array(jiraAssignableUserSchema);

export const jiraLabelsSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    maxResults: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    isLast: z.boolean(),
    values: z.array(z.string().min(1))
  })
  .passthrough();

export const jiraNamedIdSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .passthrough();
export const JIRA_CREATE_METADATA_PAGE_SIZE = 200;
export const JIRA_LABEL_PAGE_SIZE = 1000;

export type JiraIssue = z.infer<typeof jiraIssueSchema>;
