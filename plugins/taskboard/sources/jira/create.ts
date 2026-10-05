import type { z } from 'zod';
import { CREATE_OUTCOME_UNCERTAIN_MARKER } from '../../contract.js';
import type {
  ExternalWorkItemCreateInput,
  ExternalWorkItemCreateResult
} from '../types.js';
import { loadIssue, type JiraScope } from './issues.js';
import { jiraDescription, toItem } from './mapping.js';
import { assertProjectKey } from './project-key.js';
import { jiraRequest } from './request.js';
import { jiraCreatedIssueSchema } from './schemas.js';

async function postNewIssue(
  { auth }: JiraScope,
  projectKey: string,
  input: ExternalWorkItemCreateInput
): Promise<z.infer<typeof jiraCreatedIssueSchema>> {
  try {
    const payload = await jiraRequest(auth, '/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          summary: input.title,
          issuetype: { id: input.issueType },
          ...(input.description
            ? { description: jiraDescription(input.description) }
            : {}),
          ...(input.assigneeId
            ? { assignee: { accountId: input.assigneeId } }
            : {}),
          ...(input.priorityId ? { priority: { id: input.priorityId } } : {}),
          ...(input.labelIds.length > 0 ? { labels: input.labelIds } : {}),
          ...(input.dueDate ? { duedate: input.dueDate } : {})
        }
      })
    });
    return jiraCreatedIssueSchema.parse(payload);
  } catch {
    throw new Error(
      `${CREATE_OUTCOME_UNCERTAIN_MARKER} Jira may have created the issue, but Taskboard could not confirm the response. Refresh the board and check for it before trying again.`
    );
  }
}

export async function createIssue(
  scope: JiraScope,
  baseUrl: string,
  input: ExternalWorkItemCreateInput
): Promise<ExternalWorkItemCreateResult> {
  const projectKey = assertProjectKey(scope.jql, input.destinationId);
  if (input.statusId !== null) {
    throw new Error('Jira issues are created in the project default status');
  }
  if (input.milestoneId !== null) {
    throw new Error('Jira issues use a due date instead of a milestone');
  }
  if (input.issueType === null) {
    throw new Error('Choose a Jira issue type');
  }
  const created = await postNewIssue(scope, projectKey, input);
  try {
    const issue = await loadIssue(scope, created.key, {
      comments: false,
      verifyScope: false
    });
    if (issue.id !== created.id || issue.fields.project.key !== projectKey) {
      throw new Error('Jira returned an invalid new issue');
    }
    return {
      item: toItem(baseUrl, issue),
      warnings: [],
      assigneeConfirmation:
        issue.fields.assignee === null
          ? { confirmed: true, id: null }
          : issue.fields.assignee.accountId
            ? {
                confirmed: true,
                id: issue.fields.assignee.accountId
              }
            : { confirmed: false }
    };
  } catch {
    throw new Error(
      `${CREATE_OUTCOME_UNCERTAIN_MARKER} Jira created ${created.key}, but Taskboard could not confirm its details. Refresh the board and check for it before trying again.`
    );
  }
}
