import type { z } from 'zod';
import type { ExternalWorkItemCreateMetadataInput } from '../types.js';
import type { JiraScope } from './issues.js';
import { nextJiraPageStart } from './mapping.js';
import { assertProjectKey } from './project-key.js';
import { jiraRequest, type JiraAuth } from './request.js';
import {
  JIRA_CREATE_METADATA_PAGE_SIZE,
  JIRA_LABEL_PAGE_SIZE,
  jiraAssignableUserSchema,
  jiraAssignableUsersSchema,
  jiraCreateFieldsSchema,
  jiraCreateIssueTypesSchema,
  jiraLabelsSchema,
  jiraNamedIdSchema
} from './schemas.js';

type JiraIssueType = z.infer<
  typeof jiraCreateIssueTypesSchema
>['issueTypes'][number];
type JiraCreateField = z.infer<typeof jiraCreateFieldsSchema>['fields'][number];

async function loadIssueTypes(
  auth: JiraAuth,
  projectKey: string
): Promise<JiraIssueType[]> {
  const issueTypesById = new Map<string, JiraIssueType>();
  let issueTypesStart = 0;
  for (;;) {
    const issueTypesPayload = await jiraRequest(
      auth,
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?startAt=${issueTypesStart}&maxResults=${JIRA_CREATE_METADATA_PAGE_SIZE}`
    );
    const page = jiraCreateIssueTypesSchema.parse(issueTypesPayload);
    for (const issueType of page.issueTypes) {
      issueTypesById.set(issueType.id, issueType);
    }
    const nextStart = nextJiraPageStart(
      page,
      issueTypesStart,
      page.issueTypes.length
    );
    if (nextStart === null) break;
    issueTypesStart = nextStart;
  }
  return [...issueTypesById.values()].filter(issueType => !issueType.subtask);
}

function selectIssueType(
  issueTypes: JiraIssueType[],
  requested: string | null | undefined
): JiraIssueType | null {
  const requestedIssueType = requested?.trim() ?? '';
  return (
    issueTypes.find(issueType => issueType.id === requestedIssueType) ??
    (requestedIssueType
      ? issueTypes.find(
          issueType =>
            issueType.name.toLowerCase() === requestedIssueType.toLowerCase()
        )
      : undefined) ??
    issueTypes.find(issueType => issueType.name.toLowerCase() === 'task') ??
    issueTypes[0] ??
    null
  );
}

async function loadCreateFields(
  auth: JiraAuth,
  projectKey: string,
  issueTypeId: string
): Promise<Map<string, JiraCreateField>> {
  const fieldsById = new Map<string, JiraCreateField>();
  let fieldsStart = 0;
  for (;;) {
    const fieldsPayload = await jiraRequest(
      auth,
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}?startAt=${fieldsStart}&maxResults=${JIRA_CREATE_METADATA_PAGE_SIZE}`
    );
    const page = jiraCreateFieldsSchema.parse(fieldsPayload);
    for (const field of page.fields) fieldsById.set(field.fieldId, field);
    const nextStart = nextJiraPageStart(page, fieldsStart, page.fields.length);
    if (nextStart === null) break;
    fieldsStart = nextStart;
  }
  return fieldsById;
}

function loadFallbackAssignees(auth: JiraAuth, projectKey: string) {
  return jiraRequest(
    auth,
    `/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&startAt=0&maxResults=1000`
  )
    .then(payload => jiraAssignableUsersSchema.parse(payload))
    .catch(() => []);
}

async function loadLabels(auth: JiraAuth): Promise<string[]> {
  const labels = new Set<string>();
  let labelsStart = 0;
  for (;;) {
    const payload = await jiraRequest(
      auth,
      `/rest/api/3/label?startAt=${labelsStart}&maxResults=${JIRA_LABEL_PAGE_SIZE}`
    );
    const page = jiraLabelsSchema.parse(payload);
    for (const label of page.values) labels.add(label);
    const nextStart = nextJiraPageStart(page, labelsStart, page.values.length);
    if (nextStart === null) break;
    labelsStart = nextStart;
  }
  return [...labels];
}

export async function createMetadata(
  { auth, jql }: JiraScope,
  input: ExternalWorkItemCreateMetadataInput
) {
  const projectKey = assertProjectKey(jql, input.destinationId);
  const issueTypes = await loadIssueTypes(auth, projectKey);
  const selectedIssueType = selectIssueType(issueTypes, input.issueType);
  if (!selectedIssueType) {
    throw new Error(`Jira project ${projectKey} has no available issue types`);
  }
  const byId = await loadCreateFields(auth, projectKey, selectedIssueType.id);
  const assigneeField = byId.get('assignee');
  const priorityField = byId.get('priority');
  const assigneeAllowed = (assigneeField?.allowedValues ?? [])
    .map(value => jiraAssignableUserSchema.safeParse(value))
    .filter(result => result.success)
    .map(result => result.data);
  const priorityAllowed = (priorityField?.allowedValues ?? [])
    .map(value => jiraNamedIdSchema.safeParse(value))
    .filter(result => result.success)
    .map(result => result.data);
  const [fallbackAssignees, labels] = await Promise.all([
    assigneeField
      ? loadFallbackAssignees(auth, projectKey)
      : Promise.resolve([]),
    byId.has('labels') ? loadLabels(auth).catch(() => []) : Promise.resolve([])
  ]);
  const assignees = [
    ...new Map(
      [...assigneeAllowed, ...fallbackAssignees].map(user => [
        user.accountId,
        user
      ])
    ).values()
  ];
  return {
    statusOptions: [],
    assigneeOptions: assignees
      .filter(user => user.active !== false)
      .map(user => ({ id: user.accountId, label: user.displayName })),
    priorityOptions: priorityAllowed.map(priority => ({
      id: priority.id,
      label: priority.name
    })),
    labelOptions: labels.map(label => ({ id: label, label })),
    milestoneOptions: [],
    issueTypeOptions: issueTypes.map(issueType => ({
      id: issueType.id,
      label: issueType.name
    })),
    defaultStatusId: null,
    defaultIssueTypeId: selectedIssueType.id,
    supportsDueDate: byId.has('duedate')
  };
}
