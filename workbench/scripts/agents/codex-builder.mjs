import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { progress } from './progress.mjs'
import { cliTimeoutMs, partialMessage, stoppedAtDeadline } from './run-deadline.mjs'

const [codexExecutable, ...configuredArgs] = process.argv.slice(2)
const requestPath = process.env.APERTURE_RUN_REQUEST
const worktreePath = process.env.APERTURE_WORKTREE

if (!codexExecutable || !requestPath || !worktreePath) {
  console.error('codex-builder requires a Codex executable, APERTURE_RUN_REQUEST and APERTURE_WORKTREE')
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

Operate only inside the current Git worktree. Implement the requested change, add or update relevant tests when appropriate, and do not create a Git commit. Do not use network access unless the surrounding sandbox explicitly allows it. Finish with a concise summary of changed files and remaining risks.
${contextSections.join('\n')}`

// Which LLM to use comes from the Control Plane, not from the operator's own ~/.codex/config.toml: the
// runner passes it in the environment and it is translated into `-c` overrides here, so a run's model is
// whatever the Control Plane attested for that run. Without these variables Codex falls back to its own
// configuration, which keeps existing setups working.
const providerId = process.env.APERTURE_AGENT_MODEL_PROVIDER
const providerArgs = []
if (process.env.APERTURE_AGENT_MODEL) providerArgs.push('-m', process.env.APERTURE_AGENT_MODEL)
if (providerId) {
  providerArgs.push('-c', `model_provider=${providerId}`, '-c', `model_providers.${providerId}.name=${providerId}`)
  if (process.env.APERTURE_AGENT_PROVIDER_BASE_URL) providerArgs.push('-c', `model_providers.${providerId}.base_url=${process.env.APERTURE_AGENT_PROVIDER_BASE_URL}`)
  if (process.env.APERTURE_AGENT_PROVIDER_WIRE_API) providerArgs.push('-c', `model_providers.${providerId}.wire_api=${process.env.APERTURE_AGENT_PROVIDER_WIRE_API}`)
  if (process.env.APERTURE_AGENT_PROVIDER_API_KEY_ENV) providerArgs.push('-c', `model_providers.${providerId}.env_key=${process.env.APERTURE_AGENT_PROVIDER_API_KEY_ENV}`)
}
if (process.env.APERTURE_AGENT_REASONING_EFFORT) providerArgs.push('-c', `model_reasoning_effort=${process.env.APERTURE_AGENT_REASONING_EFFORT}`)

const lastMessagePath = resolve(dirname(requestPath), 'codex-last-message.txt')
progress('Codex 已启动，正在工作（Codex 不逐步报告进度）')
const result = spawnSync(codexExecutable, ['exec', '--approve-for-me', '--ephemeral', '--json', '-o', lastMessagePath, ...providerArgs, ...configuredArgs, '-'], { cwd: worktreePath, encoding: 'utf8', input: prompt, maxBuffer: 20 * 1024 * 1024, timeout: cliTimeoutMs() })

if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
const lastMessage = existsSync(lastMessagePath) ? readFileSync(lastMessagePath, 'utf8').trim() : undefined
// Stopped before the runner's deadline: what Codex wrote so far goes to the checks instead of being thrown away.
if (stoppedAtDeadline(result)) {
  console.log(partialMessage('Codex', lastMessage ? `Its last message: ${lastMessage}` : ''))
  process.exit(0)
}
if (lastMessage !== undefined) console.log(JSON.stringify({ type: 'message', summary: lastMessage.slice(0, 1000) }))
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
