import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { cliTimeoutMs, partialMessage, stoppedAtDeadline } from './run-deadline.mjs'

const [claudeExecutable, ...configuredArgs] = process.argv.slice(2)
const requestPath = process.env.APERTURE_RUN_REQUEST
const worktreePath = process.env.APERTURE_WORKTREE

if (!claudeExecutable || !requestPath || !worktreePath) {
  console.error('claude-builder requires a Claude Code executable, APERTURE_RUN_REQUEST and APERTURE_WORKTREE')
  process.exit(2)
}

const request = JSON.parse(readFileSync(requestPath, 'utf8'))
const contextSections = []
let contextBytes = 0
for (const declaredPath of request.declaredContextPaths ?? []) {
  const candidate = resolve(worktreePath, declaredPath)
  const insideWorktree = candidate === worktreePath || candidate.startsWith(`${worktreePath}${sep}`)
  if (!insideWorktree || !existsSync(candidate) || contextBytes >= 200_000) continue
  const content = readFileSync(candidate, 'utf8').slice(0, Math.max(0, 200_000 - contextBytes))
  contextBytes += Buffer.byteLength(content)
  const normalizedPath = relative(worktreePath, candidate).split(sep).join('/')
  contextSections.push(`\n## Declared context: ${normalizedPath}\n\n${content}`)
  console.log(JSON.stringify({ type: 'context_consumed', path: normalizedPath }))
}

const criteria = (request.intent.acceptanceCriteria ?? []).map((criterion) => `- [${criterion.criticality}/${criterion.verificationType}] ${criterion.statement}`).join('\n')
const revisionFeedback = request.revision?.feedback?.map((feedback) => `- ${feedback.reviewerDisplayName}: ${feedback.comment || 'Changes requested without an additional comment.'}`).join('\n')
const prompt = `You are the Builder Agent for an AI Native SDLC Control Plane run.

Target product type: ${request.workItem.productType}
Work item: ${request.workItem.title}
Goal: ${request.intent.goal}

Constraints:
${(request.intent.constraints ?? []).map((constraint) => `- ${constraint}`).join('\n') || '- None declared'}

Acceptance criteria:
${criteria}

${request.revision ? `This is a revision of Change Proposal ${request.revision.changeProposalId} at ${request.revision.previousHeadSha}.
Review feedback that must be addressed:
${revisionFeedback || '- Review requested changes; inspect the current implementation and acceptance criteria.'}` : 'This is the initial implementation run.'}

Operate only inside the current working directory, which is an isolated Git worktree.
You have file read and write tools only; you cannot run commands. The Control Plane runs the
project's declared checks after you finish, so do not try to execute the tests yourself.
Do not delete, skip or weaken existing tests. Do not add dependencies. Do not create a Git commit.
Finish with a concise summary of changed files and remaining risks.
${contextSections.join('\n')}`

const promptPath = resolve(dirname(requestPath), 'claude-prompt.txt')
writeFileSync(promptPath, prompt)

// Which LLM to use comes from the Control Plane, not from the operator's own Claude Code settings. Claude
// Code takes the model as a flag and the endpoint and credential from its environment, so the provider
// setting is translated into both. Without these variables the CLI's own configuration still applies.
const modelArgs = process.env.APERTURE_AGENT_MODEL ? ['--model', process.env.APERTURE_AGENT_MODEL] : []
const apiKeyVariable = process.env.APERTURE_AGENT_PROVIDER_API_KEY_ENV
const providerEnvironment = {
  ...(process.env.APERTURE_AGENT_PROVIDER_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.APERTURE_AGENT_PROVIDER_BASE_URL } : {}),
  ...(apiKeyVariable && process.env[apiKeyVariable] ? { ANTHROPIC_API_KEY: process.env[apiKeyVariable] } : {}),
}

const result = spawnSync(claudeExecutable, [
  '--print',
  '--output-format', 'json',
  '--permission-mode', 'acceptEdits',
  '--allowedTools', 'Read,Write,Edit,Glob,Grep',
  ...modelArgs,
  ...configuredArgs,
], { cwd: worktreePath, encoding: 'utf8', input: prompt, maxBuffer: 20 * 1024 * 1024, timeout: cliTimeoutMs(), env: { ...process.env, ...providerEnvironment } })

if (result.stderr) process.stderr.write(result.stderr)

let summary
if (result.stdout) {
  writeFileSync(resolve(dirname(requestPath), 'claude-result.json'), result.stdout)
  try {
    const payload = JSON.parse(result.stdout)
    if (typeof payload.result === 'string') summary = payload.result
    if (payload.is_error) process.stderr.write(`claude reported is_error: ${payload.subtype ?? 'unknown'}\n`)
  } catch {
    process.stderr.write('claude-builder could not parse --output-format json payload\n')
  }
}
// Stopped before the runner's deadline: what Claude Code wrote so far goes to the checks instead of being thrown away.
if (stoppedAtDeadline(result)) {
  console.log(partialMessage('Claude Code'))
  process.exit(0)
}
if (summary) console.log(JSON.stringify({ type: 'message', summary: summary.trim().slice(0, 1000) }))

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
