import type { JiraScope } from './issues.js';
import { jiraRequest } from './request.js';
import { jiraSearchPageSchema, type JiraIssue } from './schemas.js';

export async function searchIssues({
  auth,
  jql
}: JiraScope): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = [];
  const seenPageTokens = new Set<string>();
  let nextPageToken: string | undefined;
  for (;;) {
    const payload = await jiraRequest(auth, '/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql: jql.trim(),
        maxResults: 100,
        fields: [
          'summary',
          'description',
          'updated',
          'status',
          'priority',
          'assignee',
          'project',
          'labels'
        ],
        ...(nextPageToken ? { nextPageToken } : {})
      })
    });
    const page = jiraSearchPageSchema.parse(payload);
    issues.push(...page.issues);
    const token = page.nextPageToken?.trim();
    if (!token) break;
    if (seenPageTokens.has(token)) {
      throw new Error('Jira returned an invalid pagination token');
    }
    seenPageTokens.add(token);
    nextPageToken = token;
  }
  return issues;
}
