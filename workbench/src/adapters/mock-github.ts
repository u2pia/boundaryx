import type { IssueProvider, PullRequestProvider, PullRequestSnapshot } from './contracts'

type MockIssue = {
  title: string
  body: string
  state: string
  assignees: string[]
}

const issues: Record<string, MockIssue> = {
  '142': {
    title: '为企业工作区增加 SSO 登录',
    body: '支持 OIDC Provider、现有账号绑定、会话撤销和离线部署。',
    state: 'open',
    assignees: ['mia-chen'],
  },
  '155': {
    title: '同步 GitLab Merge Request 状态',
    body: '在保留 GitLab 权威状态的前提下投影 MR、审批与流水线结果。',
    state: 'open',
    assignees: ['jian-li'],
  },
}

const pullRequests: Record<string, PullRequestSnapshot> = {
  '428': {
    title: 'feat(auth): add enterprise OIDC login',
    state: 'open',
    author: 'mia-chen',
    baseRef: 'main',
    headRef: 'feat/enterprise-oidc',
    headSha: '8f3a2c1d90a7',
    changedFiles: 8,
    additions: 426,
    deletions: 118,
    reviewDecision: 'approved',
    checks: [
      { name: 'unit-and-integration', status: 'completed', conclusion: 'success', detailsUrl: 'mock://github/checks/428/tests' },
      { name: 'security-scan', status: 'completed', conclusion: 'success', detailsUrl: 'mock://github/checks/428/security' },
      { name: 'coverage', status: 'completed', conclusion: 'success', detailsUrl: 'mock://github/checks/428/coverage' },
    ],
  },
  '512': {
    title: 'fix(policy): isolate untrusted MCP content',
    state: 'open',
    author: 'alex-wu',
    baseRef: 'main',
    headRef: 'fix/mcp-isolation',
    headSha: '61ac9e3b172f',
    changedFiles: 5,
    additions: 214,
    deletions: 39,
    reviewDecision: 'changes_requested',
    checks: [
      { name: 'unit-and-integration', status: 'completed', conclusion: 'failure', detailsUrl: 'mock://github/checks/512/tests' },
      { name: 'security-scan', status: 'completed', conclusion: 'success', detailsUrl: 'mock://github/checks/512/security' },
    ],
  },
}

function normalizeExternalId(externalId: string) {
  return externalId.trim().replace(/^#/, '')
}

export class MockGitHubIssueProvider implements IssueProvider {
  readonly id = 'mock-github@0.1'
  private projections = new Map<string, string>()

  async readIssue(externalId: string) {
    const normalized = normalizeExternalId(externalId)
    const issue = issues[normalized]
    if (!issue) throw new Error(`GitHub Issue #${normalized} not found`)
    return { ...issue, assignees: [...issue.assignees] }
  }

  async writeIntentProjection(externalId: string, summary: string) {
    const normalized = normalizeExternalId(externalId)
    if (!issues[normalized]) throw new Error(`GitHub Issue #${normalized} not found`)
    this.projections.set(normalized, summary)
  }

  getProjection(externalId: string) {
    return this.projections.get(normalizeExternalId(externalId))
  }
}

export class MockGitHubPullRequestProvider implements PullRequestProvider {
  readonly id = 'mock-github-pr@0.1'
  private projections = new Map<string, string>()

  async readPullRequest(externalId: string) {
    const normalized = normalizeExternalId(externalId)
    const pullRequest = pullRequests[normalized]
    if (!pullRequest) throw new Error(`GitHub Pull Request #${normalized} not found`)
    return { ...pullRequest, checks: pullRequest.checks.map((check) => ({ ...check })) }
  }

  async writeEvidenceProjection(externalId: string, summary: string) {
    const normalized = normalizeExternalId(externalId)
    if (!pullRequests[normalized]) throw new Error(`GitHub Pull Request #${normalized} not found`)
    this.projections.set(normalized, summary)
  }

  getProjection(externalId: string) {
    return this.projections.get(normalizeExternalId(externalId))
  }
}
