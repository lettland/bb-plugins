export const issueFields = `
  id
  identifier
  title
  description
  url
  priorityLabel
  updatedAt
  state { id name type }
  assignee { id name }
  team { key name }
  project { name }
  labels(first: 100) { nodes { name } }
`;

export const teamIssuesQuery = `
  query TeamIssues($teamKey: String!, $after: String) {
    issues(
      first: 100
      after: $after
      orderBy: updatedAt
      filter: {
        team: { key: { eqIgnoreCase: $teamKey } }
        state: { type: { nin: ["completed", "canceled"] } }
      }
    ) {
      nodes { ${issueFields} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const issueQuery = `
  query TaskboardLinearIssue($id: String!) {
    issue(id: $id) {
      ${issueFields}
      comments(first: 50) {
        nodes { body createdAt user { name } }
      }
    }
  }
`;

export const issueStatusOptionsQuery = `
  query TaskboardLinearStatusOptions($id: String!) {
    issue(id: $id) {
      id
      state { id name type }
      team {
        key
        states { nodes { id name type } }
      }
    }
  }
`;

export const updateIssueStatusMutation = `
  mutation TaskboardLinearUpdateStatus($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue { ${issueFields} }
    }
  }
`;

export const teamForCreateQuery = `
  query TaskboardLinearCreateTeam($teamKey: String!) {
    teams(filter: { key: { eqIgnoreCase: $teamKey } }, first: 2) {
      nodes { id key name }
    }
  }
`;

export const createMetadataQuery = `
  query TaskboardLinearCreateMetadata(
    $teamKey: String!
    $statesAfter: String
    $membersAfter: String
    $labelsAfter: String
  ) {
    teams(filter: { key: { eqIgnoreCase: $teamKey } }, first: 2) {
      nodes {
        id
        key
        name
        states(first: 50, after: $statesAfter) {
          nodes { id name type }
          pageInfo { hasNextPage endCursor }
        }
        members(first: 50, after: $membersAfter) {
          nodes { id name }
          pageInfo { hasNextPage endCursor }
        }
        labels(first: 50, after: $labelsAfter) {
          nodes { id name }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export const createIssueMutation = `
  mutation TaskboardLinearCreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { ${issueFields} }
    }
  }
`;
