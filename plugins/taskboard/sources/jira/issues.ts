import type { ExternalWorkStatusOption } from '../types.js';
import { stateCategory } from './mapping.js';
import { jiraRequest, type JiraAuth } from './request.js';
import {
  jiraIssueSchema,
  jiraJqlMatchSchema,
  jiraTransitionsSchema,
  type JiraIssue
} from './schemas.js';

export interface JiraScope {
  auth: JiraAuth;
  jql: string;
}

export type JiraTransitionOption = ExternalWorkStatusOption & {
  transitionId: string | null;
};

export async function loadIssue(
  { auth, jql }: JiraScope,
  locator: string,
  flags: { comments: boolean; verifyScope: boolean }
): Promise<JiraIssue> {
  const fields = [
    'summary',
    'description',
    'updated',
    'status',
    'priority',
    'assignee',
    'project',
    'labels',
    ...(flags.comments ? ['comment'] : [])
  ].join(',');
  const payload = await jiraRequest(
    auth,
    `/rest/api/3/issue/${encodeURIComponent(locator)}?fields=${encodeURIComponent(fields)}`
  );
  const issue = jiraIssueSchema.parse(payload);
  if (issue.key !== locator) {
    throw new Error(`Jira returned the wrong issue for ${locator}`);
  }
  if (!flags.verifyScope) return issue;
  const issueId = Number(issue.id);
  if (!Number.isSafeInteger(issueId)) {
    throw new Error(`Jira returned an invalid issue id for ${locator}`);
  }
  const matchPayload = await jiraRequest(auth, '/rest/api/3/jql/match', {
    method: 'POST',
    body: JSON.stringify({
      issueIds: [issueId],
      jqls: [jql.trim()]
    })
  });
  const match = jiraJqlMatchSchema.parse(matchPayload).matches[0];
  if (!match || match.errors.length > 0) {
    throw new Error('Jira could not verify the configured scope');
  }
  if (!match.matchedIssues.includes(issueId)) {
    throw new Error(`Jira issue ${locator} is outside the configured scope`);
  }
  return issue;
}

export async function transitionOptions(
  scope: JiraScope,
  locator: string
): Promise<{
  issue: JiraIssue;
  options: JiraTransitionOption[];
}> {
  const issue = await loadIssue(scope, locator, {
    comments: false,
    verifyScope: true
  });
  const payload = await jiraRequest(
    scope.auth,
    `/rest/api/3/issue/${encodeURIComponent(locator)}/transitions`
  );
  const transitions = jiraTransitionsSchema.parse(payload).transitions;
  const available = new Map<string, JiraTransitionOption>();
  available.set(issue.fields.status.id, {
    id: issue.fields.status.id,
    name: issue.fields.status.name,
    stateCategory: stateCategory(issue.fields.status.statusCategory.key),
    current: true,
    transitionId: null
  });
  for (const transition of transitions) {
    if (available.has(transition.to.id)) continue;
    available.set(transition.to.id, {
      id: transition.to.id,
      name: transition.to.name,
      stateCategory: stateCategory(transition.to.statusCategory.key),
      current: transition.to.id === issue.fields.status.id,
      transitionId: transition.id
    });
  }
  return { issue, options: [...available.values()] };
}
