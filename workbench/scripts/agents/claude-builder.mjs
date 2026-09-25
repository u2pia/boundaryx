import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { progress } from './progress.mjs'
import { cliTimeoutMs, partialMessage } from './run-deadline.mjs'

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

// stream-json reports each tool call as it happens, so the running Intent shows what Claude Code is working on.
const child = spawn(claudeExecutable, [
  '--print',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'acceptEdits',
  '--allowedTools', 'Read,Write,Edit,Glob,Grep',
  ...modelArgs,
  ...configuredArgs,
], { cwd: worktreePath, env: { ...process.env, ...providerEnvironment } })
progress('Claude Code 已启动，正在阅读需求')
// A CLI that never reads its input must not crash the wrapper.
child.stdin.on('error', () => {})
child.stdin.end(prompt)
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

// Stopped before the runner's deadline: what Claude Code wrote so far goes to the checks instead of being thrown away.
let stoppedAtDeadline = false
const timeoutMs = cliTimeoutMs()
const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
  stoppedAtDeadline = true
  child.kill('SIGTERM')
}, timeoutMs)
// A cancelled run signals this process; Claude Code must stop with it rather than keep editing.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { child.kill(signal); process.exit(1) })

const toolLabels = { Read: '读取', Write: '写入', Edit: '修改', Glob: '查找文件', Grep: '搜索' }
// Claude Code reports resolved paths, which differ from the worktree path wherever it passes through a symlink.
const worktreeRoots = [...new Set([worktreePath, realpathSync(worktreePath)])]
function worktreeRelative(path) {
  const inside = worktreeRoots.map((root) => relative(root, path)).find((candidate) => !candidate.startsWith('..'))
  return inside === undefined ? path : inside.split(sep).join('/')
}
function describeTool(use) {
  const input = use.input ?? {}
  const target = input.file_path ? worktreeRelative(String(input.file_path)) : input.pattern ?? ''
  return `${toolLabels[use.name] ?? use.name}${target ? ` ${target}` : ''}`
}

let resultLine
let buffered = ''
function readLine(line) {
  if (!line.trim()) return
  let event
  try { event = JSON.parse(line) } catch { return }
  if (event.type === 'assistant') {
    for (const part of event.message?.content ?? []) if (part.type === 'tool_use') progress(describeTool(part))
  } else if (event.type === 'result' || (event.type === undefined && 'result' in event)) {
    resultLine = line
  }
}
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffered += chunk
  const lines = buffered.split('\n')
  buffered = lines.pop()
  lines.forEach(readLine)
})

const { status, error } = await new Promise((done) => {
  child.on('error', (spawnError) => done({ status: null, error: spawnError }))
  child.on('close', (code) => done({ status: code, error: undefined }))
})
clearTimeout(timer)
readLine(buffered)

let summary
if (resultLine) {
  writeFileSync(resolve(dirname(requestPath), 'claude-result.json'), resultLine)
  const payload = JSON.parse(resultLine)
  if (typeof payload.result === 'string') summary = payload.result
  if (payload.is_error) process.stderr.write(`claude reported is_error: ${payload.subtype ?? 'unknown'}\n`)
} else if (!stoppedAtDeadline && !error) {
  process.stderr.write('claude-builder found no result in the --output-format stream-json output\n')
}
if (stoppedAtDeadline) {
  console.log(partialMessage('Claude Code'))
  process.exit(0)
}
if (summary) console.log(JSON.stringify({ type: 'message', summary: summary.trim().slice(0, 1000) }))

if (error) {
  console.error(error.message)
  process.exit(1)
}
process.exit(status ?? 1)
