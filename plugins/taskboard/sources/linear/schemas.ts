import { z } from 'zod';

export const namedSchema = z.object({ name: z.string() }).strict();
export const assigneeSchema = z
  .object({ id: z.string().min(1), name: z.string() })
  .strict();
export const stateSchema = z
  .object({ id: z.string().min(1), name: z.string(), type: z.string() })
  .strict();
export const createOptionSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .strict();
export const createMetadataPageInfoSchema = z
  .object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable()
  })
  .strict();
export function createMetadataConnectionSchema<T extends z.ZodTypeAny>(
  nodeSchema: T
) {
  return z
    .object({
      nodes: z.array(nodeSchema),
      pageInfo: createMetadataPageInfoSchema
    })
    .strict();
}
export const createMetadataTeamSchema = z
  .object({
    id: z.string().min(1),
    key: z.string().min(1),
    name: z.string(),
    states: createMetadataConnectionSchema(stateSchema),
    members: createMetadataConnectionSchema(createOptionSchema),
    labels: createMetadataConnectionSchema(createOptionSchema)
  })
  .strict();
export const issueSchema = z
  .object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    title: z.string(),
    description: z.string().nullable(),
    url: z.string(),
    priorityLabel: z.string(),
    updatedAt: z.string(),
    state: stateSchema,
    assignee: assigneeSchema.nullable(),
    team: z.object({ key: z.string(), name: z.string() }).strict(),
    project: namedSchema.nullable(),
    labels: z.object({ nodes: z.array(namedSchema) }).strict(),
    comments: z
      .object({
        nodes: z.array(
          z
            .object({
              body: z.string(),
              createdAt: z.string(),
              user: namedSchema.nullable()
            })
            .strict()
        )
      })
      .strict()
      .optional()
  })
  .strict();

export const issueConnectionSchema = z
  .object({
    nodes: z.array(issueSchema),
    pageInfo: z
      .object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable()
      })
      .strict()
  })
  .strict();

export type LinearIssue = z.infer<typeof issueSchema>;
export type LinearState = z.infer<typeof stateSchema>;
export type LinearCreateOption = z.infer<typeof createOptionSchema>;
