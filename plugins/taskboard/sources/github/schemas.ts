import { z } from 'zod';

export const githubItemSchema = z
  .object({
    repo: z.string(),
    number: z.number().int().positive(),
    kind: z.enum(['issue', 'pr']),
    title: z.string(),
    state: z.string(),
    author: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    url: z.string(),
    body: z.string(),
    updatedAt: z.string()
  })
  .strict();

export const listOutputSchema = z
  .object({ items: z.array(githubItemSchema) })
  .strict();

export const detailOutputSchema = z
  .object({
    issue: githubItemSchema
      .omit({ kind: true })
      .extend({
        comments: z.array(
          z
            .object({
              author: z.string(),
              body: z.string(),
              createdAt: z.string()
            })
            .strict()
        )
      })
      .strict()
  })
  .strict();

export const githubStatusOutputSchema = z
  .object({
    ghOk: z.boolean(),
    ghError: z.string().nullable(),
    repos: z.array(
      z.object({ repo: z.string(), projectId: z.string().nullable() }).strict()
    ),
    lastSyncedAt: z.string().nullable()
  })
  .strict();

export const refreshOutputSchema = z
  .object({
    repos: z.number().int().nonnegative(),
    items: z.number().int().nonnegative()
  })
  .strict();

export const okOutputSchema = z.object({ ok: z.literal(true) }).strict();

export const githubAssigneeSchema = z
  .object({ login: z.string().min(1) })
  .passthrough();
export const paginatedGithubAssigneesSchema = z.array(
  z.array(githubAssigneeSchema)
);
export const githubLabelSchema = z
  .object({ name: z.string().min(1) })
  .passthrough();
export const paginatedGithubLabelsSchema = z.array(z.array(githubLabelSchema));
export const githubMilestoneSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    due_on: z.string().nullable().optional()
  })
  .passthrough();
export const paginatedGithubMilestonesSchema = z.array(
  z.array(githubMilestoneSchema)
);
export const createdGithubIssueSchema = z
  .object({
    number: z.number().int().positive(),
    html_url: z.string().min(1),
    assignees: z
      .array(z.object({ login: z.string().min(1) }).passthrough()),
    labels: z
      .array(
        z.union([
          z.string(),
          z.object({ name: z.string().min(1) }).passthrough()
        ])
      )
      .default([]),
    milestone: z
      .object({ number: z.number().int().positive() })
      .passthrough()
      .nullable()
      .default(null)
  })
  .passthrough();

export type GithubItem = z.infer<typeof githubItemSchema>;
export type GithubStatus = z.infer<typeof githubStatusOutputSchema>;
export type GithubMilestone = z.infer<typeof githubMilestoneSchema>;
export type CreatedGithubIssue = z.infer<typeof createdGithubIssueSchema>;
