import assert from 'node:assert/strict'
import { MockGitHubIssueProvider, MockGitHubPullRequestProvider } from '../src/adapters/mock-github.ts'

const provider = new MockGitHubIssueProvider()
const issue = await provider.readIssue('#142')

assert.equal(issue.title, '为企业工作区增加 SSO 登录')
assert.equal(issue.state, 'open')
assert.deepEqual(issue.assignees, ['mia-chen'])

await provider.writeIntentProjection('142', 'INT-145 · 3 acceptance criteria pending')
assert.equal(provider.getProjection('#142'), 'INT-145 · 3 acceptance criteria pending')

await assert.rejects(() => provider.readIssue('#999'), /not found/)

const pullRequestProvider = new MockGitHubPullRequestProvider()
const approvedPullRequest = await pullRequestProvider.readPullRequest('#428')
assert.equal(approvedPullRequest.reviewDecision, 'approved')
assert.equal(approvedPullRequest.checks.every((check) => check.conclusion === 'success'), true)

const blockedPullRequest = await pullRequestProvider.readPullRequest('#512')
assert.equal(blockedPullRequest.reviewDecision, 'changes_requested')
assert.equal(blockedPullRequest.checks.some((check) => check.conclusion === 'failure'), true)

await pullRequestProvider.writeEvidenceProjection('428', 'RUN-001 · local://evidence/run-001.json')
assert.equal(pullRequestProvider.getProjection('#428'), 'RUN-001 · local://evidence/run-001.json')
await assert.rejects(() => pullRequestProvider.readPullRequest('#999'), /not found/)

console.log('github adapter smoke tests passed')
