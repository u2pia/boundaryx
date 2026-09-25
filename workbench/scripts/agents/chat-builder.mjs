import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

// A Builder Agent with no external CLI: it drives any OpenAI-compatible Chat Completions endpoint (DeepSeek,
// Qwen, OpenAI, vLLM, Ollama, a gateway) through tool calls, so which model writes the code is decided only by
// the Control Plane's provider setting. Its tools are confined to the run's worktree.
const requestPath = process.env.APERTURE_RUN_REQUEST
const worktreePath = process.env.APERTURE_WORKTREE
const baseUrl = process.env.APERTURE_AGENT_PROVIDER_BASE_URL?.replace(/\/+$/u, '')
const model = process.env.APERTURE_AGENT_MODEL
const apiKeyVariable = process.env.APERTURE_AGENT_PROVIDER_API_KEY_ENV
const apiKey = apiKeyVariable ? process.env[apiKeyVariable] : undefined
const maxSteps = Number(process.env.APERTURE_BUILDER_MAX_STEPS) || 120

if (!requestPath || !worktreePath || !baseUrl || !model) {
  console.error('chat-builder requires APERTURE_RUN_REQUEST, APERTURE_WORKTREE, and a provider with a base URL and model configured in the Control Plane')
  process.exit(2)
}

const root = realpathSync(worktreePath)
const request = JSON.parse(readFileSync(requestPath, 'utf8'))
const contextSections = []
let contextBytes = 0
for (const declaredPath of request.declaredContextPaths ?? []) {
  const candidate = resolve(worktreePath, declaredPath)
  const insideWorktree = candidate === worktreePath || candidate.startsWith(`${worktreePath}${sep}`)
  if (!insideWorktree || !existsSync(candidate) || !statSync(candidate).isFile() || contextBytes >= 200_000) continue
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

You work through the provided tools inside an isolated Git worktree; paths are relative to its root.
Start by listing and reading the files you need; call several tools in one turn when they are independent
(for example, read all the files you need at once). Make the change with write_file or replace_in_file, add or
update relevant tests, and run the project's tests with run_command when that is useful. Do not delete,
skip or weaken existing tests. Do not create a Git commit: the Control Plane commits your changes.
When you are done, call finish with a concise summary of changed files and remaining risks.
${contextSections.join('\n')}`

const tools = [
  { name: 'list_files', description: 'List files tracked or untracked (not ignored) in the worktree, optionally under a directory.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory relative to the worktree root; defaults to the root.' } } } },
  { name: 'read_file', description: 'Read a UTF-8 text file. Long files are returned in slices; use offset to continue.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', description: 'Character offset to start from.' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or overwrite a file with the given content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'replace_in_file', description: 'Replace exactly one occurrence of old_string with new_string in a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'run_command', description: 'Run a shell command in the worktree root (e.g. the test suite). 180 s timeout; output is truncated.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'finish', description: 'End the run with a summary of changed files and remaining risks.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
].map((tool) => ({ type: 'function', function: tool }))

/** Resolves a model-supplied path, refusing anything outside the worktree (including through a symlink) and .git. */
function worktreeFile(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('path is required')
  const candidate = resolve(root, path)
  let existing = candidate
  while (!existsSync(existing)) existing = dirname(existing)
  const real = realpathSync(existing)
  const outside = (value) => value !== root && !value.startsWith(`${root}${sep}`)
  if (outside(candidate) || outside(real)) throw new Error(`${path} is outside the worktree`)
  const relativePath = relative(root, candidate).split(sep).join('/')
  if (relativePath === '.git' || relativePath.startsWith('.git/')) throw new Error('.git is managed by the Control Plane')
  return { absolute: candidate, relativePath: relativePath || '.' }
}

// The command sees neither the provider credential nor the provider settings: a test suite has no business
// with the key, and a command that printed its environment would otherwise put it in the conversation.
const commandEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== apiKeyVariable && !key.startsWith('APERTURE_AGENT_')))
const forbiddenGit = /\bgit\s+(commit|push|reset|rebase|merge|checkout|switch|stash|tag|branch\s+-[dD]|worktree|remote)\b/u

/** A command as it reads in the run log: relative to the worktree (the absolute root says nothing) with its outcome. */
function describeCommand(command, output) {
  const relativeCommand = String(command).replaceAll(`${root}/`, '').replaceAll(root, '.').replace(/^cd "?\.?"? *&& */u, '')
  const status = String(output).split('\n')[0]
  return `${relativeCommand.length > 160 ? `${relativeCommand.slice(0, 160)}…` : relativeCommand} → ${status.startsWith('exit ') || status.startsWith('failed') ? status : 'rejected'}`
}

const handlers = {
  list_files({ path = '.' }) {
    const { relativePath } = worktreeFile(path)
    const result = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', ...(relativePath === '.' ? [] : ['--', relativePath])], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
    const files = (result.stdout ?? '').split('\n').filter(Boolean)
    return files.length > 500 ? `${files.slice(0, 500).join('\n')}\n… ${files.length - 500} more; list a subdirectory` : files.join('\n') || '(no files)'
  },
  read_file({ path, offset = 0 }) {
    const { absolute, relativePath } = worktreeFile(path)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`${relativePath} is not a file`)
    const content = readFileSync(absolute, 'utf8')
    console.log(JSON.stringify({ type: 'context_consumed', path: relativePath }))
    const start = Math.max(0, Number(offset) || 0)
    const slice = content.slice(start, start + 60_000)
    return start + slice.length < content.length ? `${slice}\n… truncated at character ${start + slice.length} of ${content.length}; read again with offset` : slice
  },
  write_file({ path, content }) {
    const { absolute, relativePath } = worktreeFile(path)
    if (typeof content !== 'string') throw new Error('content must be a string')
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
    return `wrote ${relativePath} (${Buffer.byteLength(content)} bytes)`
  },
  replace_in_file({ path, old_string: oldString, new_string: newString }) {
    const { absolute, relativePath } = worktreeFile(path)
    if (typeof oldString !== 'string' || !oldString || typeof newString !== 'string') throw new Error('old_string and new_string are required')
    const content = readFileSync(absolute, 'utf8')
    const count = content.split(oldString).length - 1
    if (count !== 1) throw new Error(`old_string occurs ${count} times in ${relativePath}; it must occur exactly once`)
    writeFileSync(absolute, content.replace(oldString, () => newString))
    return `edited ${relativePath}`
  },
  run_command({ command }) {
    if (typeof command !== 'string' || !command.trim()) throw new Error('command is required')
    if (forbiddenGit.test(command)) throw new Error('Git history and branches are managed by the Control Plane; only read-only git commands are allowed')
    const result = spawnSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 20 * 1024 * 1024, env: commandEnvironment })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const status = result.error ? `failed to run: ${result.error.message}` : `exit ${result.status}`
    return `${status}\n${output.length > 12_000 ? `… ${output.length - 12_000} characters omitted …\n${output.slice(-12_000)}` : output}`
  },
}

async function complete(messages, offered = tools, toolChoice = 'auto') {
  const body = { model, messages, tools: offered, tool_choice: toolChoice, ...(process.env.APERTURE_AGENT_REASONING_EFFORT ? { reasoning_effort: process.env.APERTURE_AGENT_REASONING_EFFORT } : {}) }
  for (let attempt = 1; ; attempt += 1) {
    let response
    try {
      response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) })
    } catch (error) {
      if (attempt < 3) continue
      throw new Error(`${baseUrl}/chat/completions is unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    // Not every OpenAI-compatible server accepts a named tool_choice; the finish-only tool list still applies.
    if (response.status === 400 && body.tool_choice !== 'auto') {
      body.tool_choice = 'auto'
      continue
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await new Promise((done) => setTimeout(done, attempt * 5_000))
      continue
    }
    // The provider's message only, never the request: the request carries the key in a header.
    if (!response.ok) throw new Error(`${baseUrl}/chat/completions → ${response.status}: ${text.slice(0, 500)}`)
    const payload = JSON.parse(text)
    const message = payload.choices?.[0]?.message
    if (!message) throw new Error(`${baseUrl}/chat/completions returned no message`)
    return message
  }
}

const messages = [{ role: 'system', content: prompt }, { role: 'user', content: 'Implement the change described above, then call finish.' }]
let summary
try {
  for (let step = 1; step <= maxSteps && summary === undefined; step += 1) {
    // Near the end of the budget the model is told to wrap up; on the last step finish is the only tool it has,
    // so a long run ends with a summary and its changes reach the checks instead of being thrown away.
    if (step === maxSteps - 10) messages.push({ role: 'user', content: 'You have 10 steps left. Wrap up: make sure your changes are complete and consistent, then call finish.' })
    const last = step === maxSteps
    if (last) messages.push({ role: 'user', content: 'This is your last step. Call finish now with a summary of what you changed and what is left undone.' })
    // Models do not all honour a narrowed tool list, so the last step also forces finish and runs nothing else.
    const message = await complete(messages, last ? tools.filter((tool) => tool.function.name === 'finish') : tools, last ? { type: 'function', function: { name: 'finish' } } : 'auto')
    const calls = message.tool_calls ?? []
    // reasoning_content is not echoed back: some providers reject it in the request.
    messages.push({ role: 'assistant', content: message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) })
    if (calls.length === 0) {
      // A model that answers in prose instead of calling finish has finished all the same.
      summary = message.content?.trim() || 'Builder finished without a summary.'
      break
    }
    for (const call of calls) {
      const name = call.function?.name
      let args = {}
      let output
      try {
        args = JSON.parse(call.function?.arguments || '{}')
        if (name === 'finish') {
          summary = String(args.summary ?? '').trim() || 'Builder finished without a summary.'
          output = 'ok'
        } else if (last) output = 'not run: the step budget is spent; call finish'
        else if (handlers[name]) output = handlers[name](args)
        else output = `unknown tool ${name}`
      } catch (error) {
        output = `error: ${error instanceof Error ? error.message : String(error)}`
      }
      console.error(`[chat-builder] step ${step} ${name}${args.path ? ` ${args.path}` : ''}${args.command ? ` ${describeCommand(args.command, output)}` : ''}${String(output).startsWith('error: ') ? ` → ${String(output).slice(0, 160)}` : ''}`)
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(output) })
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

if (summary === undefined) {
  console.error(`chat-builder stopped after ${maxSteps} steps without calling finish`)
  process.exit(1)
}
console.log(JSON.stringify({ type: 'message', summary: summary.slice(0, 1000) }))
