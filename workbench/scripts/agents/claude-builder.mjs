import { spawn } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { progress } from './progress.mjs'
import { cliTimeoutMs, partialMessage } from './run-deadline.mjs'
import { declaredContextSections, taskPrompt } from './run-request.mjs'

const [claudeExecutable, ...configuredArgs] = process.argv.slice(2)
const requestPath = process.env.APERTURE_RUN_REQUEST
const worktreePath = process.env.APERTURE_WORKTREE

if (!claudeExecutable || !requestPath || !worktreePath) {
  console.error('claude-builder requires a Claude Code executable, APERTURE_RUN_REQUEST and APERTURE_WORKTREE')
  process.exit(2)
}

// The worktree is the repository under change, so nothing in it may configure the engine that changes it: its
// .claude/settings*.json could allow Bash, add hooks that run on this host or set environment variables, its .mcp.json
// could start servers, and its CLAUDE.md and .claude/skills are instructions no manifest declared. These flags keep
// only the operator's own settings (~/.claude/settings.json, where the gateway and credential live), take every
// built-in tool that runs code out of the engine rather than just not pre-approving it, and start no MCP server.
// Whether a flag given twice takes the first or the last value is not documented, so the configured arguments may
// not name any of them at all.
const TOOLS = 'Read,Write,Edit,Glob,Grep'
const hardeningArgs = [
  '--setting-sources', 'user',
  '--settings', JSON.stringify({ disableAllHooks: true }),
  '--strict-mcp-config',
  '--tools', TOOLS,
  '--allowedTools', TOOLS,
  '--disallowedTools', 'mcp__*',
  '--disable-slash-commands',
]
const hardeningFlags = ['--setting-sources', '--settings', '--strict-mcp-config', '--mcp-config', '--tools', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--disable-slash-commands', '--permission-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--add-dir', '--plugin-dir', '--agents', '--bare', '--safe-mode', '--restricted']
const overriding = configuredArgs.filter((arg) => hardeningFlags.includes(arg.split('=')[0]))
if (overriding.length) {
  console.error(`claude-builder sets ${overriding.join(', ')} itself; remove them from the configured arguments`)
  process.exit(2)
}

const request = JSON.parse(readFileSync(requestPath, 'utf8'))
const contextSections = declaredContextSections(request)
const prompt = `${taskPrompt(request)}

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
  ...hardeningArgs,
  ...modelArgs,
  ...configuredArgs,
], { cwd: worktreePath, env: { ...process.env, ...providerEnvironment, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } })
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

// What Claude Code read, from its own event stream: a Read, or a Grep that returned matching lines, counts once its
// tool_result came back without an error, so a call the engine refused or that failed is not a read. Still reported
// from inside the run, so the runner records it as not independently observed.
const pendingReads = new Map()
const reportedReads = new Set()
function readOf(use) {
  const input = use.input ?? {}
  if (use.name === 'Read' && typeof input.file_path === 'string') return { tool: 'Read', path: worktreeRelative(input.file_path), offset: input.offset, limit: input.limit }
  if (use.name === 'Grep' && input.output_mode === 'content') return { tool: 'Grep', path: typeof input.path === 'string' ? worktreeRelative(input.path) || '.' : '.' }
  return undefined
}
function reportRead(read) {
  const key = JSON.stringify(read)
  if (reportedReads.has(key)) return
  reportedReads.add(key)
  console.log(JSON.stringify({ type: 'context_consumed', source: 'engine_stream', path: read.path, tool: read.tool, ...(Number.isSafeInteger(read.offset) ? { offset: read.offset } : {}), ...(Number.isSafeInteger(read.limit) ? { limit: read.limit } : {}) }))
}

let resultLine
let buffered = ''
function readLine(line) {
  if (!line.trim()) return
  let event
  try { event = JSON.parse(line) } catch { return }
  if (event.type === 'assistant') {
    for (const part of event.message?.content ?? []) {
      if (part.type !== 'tool_use') continue
      progress(describeTool(part))
      const read = readOf(part)
      if (read && typeof part.id === 'string') pendingReads.set(part.id, read)
    }
  } else if (event.type === 'user') {
    for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (part.type !== 'tool_result' || !pendingReads.has(part.tool_use_id)) continue
      if (part.is_error !== true) reportRead(pendingReads.get(part.tool_use_id))
      pendingReads.delete(part.tool_use_id)
    }
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
