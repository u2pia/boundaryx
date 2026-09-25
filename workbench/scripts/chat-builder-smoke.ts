import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const agents = resolve(dirname(fileURLToPath(import.meta.url)), 'agents')
const root = mkdtempSync(join(tmpdir(), 'aperture-chat-builder-'))
const workspace = join(root, 'workspace')
const requestPath = join(root, 'request.json')
const secret = 'sk-test-never-leaves-the-builder'

mkdirSync(workspace)
writeFileSync(join(workspace, 'README.md'), '# Fixture\n')
writeFileSync(join(root, 'outside.txt'), 'not yours\n')
spawnSync('git', ['init', '--quiet', workspace])
writeFileSync(requestPath, JSON.stringify({ runId: 'RUN-CHAT', workItem: { title: 'Build fixture', productType: 'application' }, intent: { goal: 'Create src/generated.ts', constraints: ['offline'], acceptanceCriteria: [{ statement: 'File exists', criticality: 'critical', verificationType: 'deterministic' }] }, declaredContextPaths: ['README.md'] }))

type ChatRequest = { model: string; messages: Array<{ role: string; content: string | null; tool_call_id?: string }>; tools: Array<{ function: { name: string } }>; tool_choice?: unknown }
const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
// The model's side of the conversation, one reply per request.
const script = [
  { tool_calls: [call('c1', 'list_files', {}), call('c2', 'read_file', { path: 'README.md' }), call('c3', 'read_file', { path: '../outside.txt' }), call('c4', 'write_file', { path: '.git/hooks/pre-commit', content: 'x' })] },
  { tool_calls: [call('c5', 'write_file', { path: 'src/generated.ts', content: 'export const generated = 1\n' }), call('c6', 'replace_in_file', { path: 'src/generated.ts', old_string: '= 1', new_string: '= true' }), call('c7', 'run_command', { command: 'git commit -am sneaky' }), call('c8', 'run_command', { command: 'env' })] },
  { tool_calls: [call('c9', 'finish', { summary: 'Created src/generated.ts.' })] },
]
const requests: ChatRequest[] = []
const budgetRequests: ChatRequest[] = []
const clockRequests: ChatRequest[] = []
const headers: IncomingMessage['headers'][] = []
const server = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    // A model that never finishes on its own, to exercise the step budget.
    if (request.url === '/budget/chat/completions') {
      const parsed = JSON.parse(body) as ChatRequest
      budgetRequests.push(parsed)
      // Like DeepSeek, it ignores a narrowed tool list and only a forced tool_choice makes it call finish, and even
      // then it tries one more command first.
      const forced = JSON.stringify(parsed.tool_choice) === JSON.stringify({ type: 'function', function: { name: 'finish' } })
      const reply = forced ? { tool_calls: [call('b-last', 'run_command', { command: 'touch ignored-command' }), call('b-finish', 'finish', { summary: 'Stopped at the step budget; README reviewed.' })] } : { tool_calls: [call(`b${budgetRequests.length}`, 'list_files', {})] }
      return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, ...reply } }] }))
    }
    // A slow model that never finishes on its own, to exercise the time budget. `stall` never answers the forced
    // finish at all, so not even the summary fits in the time that is left.
    if (request.url === '/clock/chat/completions' || request.url === '/stall/chat/completions') {
      const parsed = JSON.parse(body) as ChatRequest
      clockRequests.push(parsed)
      const forced = JSON.stringify(parsed.tool_choice) === JSON.stringify({ type: 'function', function: { name: 'finish' } })
      if (forced && request.url === '/stall/chat/completions') return
      const warned = /seconds of working time are left/u.test(JSON.stringify(parsed.messages))
      // Once warned, it still starts a command that would outlast the deadline.
      const reply = forced ? { tool_calls: [call('t-finish', 'finish', { summary: 'README reviewed.' })] } : warned && !JSON.stringify(parsed.messages).includes('t-slow') ? { tool_calls: [call('t-slow', 'run_command', { command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => require('node:fs').writeFileSync('late-command', ''), 10000)"` })] } : { tool_calls: [call(`t${clockRequests.length}`, 'list_files', {})] }
      return setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, ...reply } }] })), 150)
    }
    if (request.url !== '/v1/chat/completions') return response.writeHead(404).end()
    requests.push(JSON.parse(body) as ChatRequest)
    headers.push(request.headers)
    const reply = script[requests.length - 1] ?? { content: 'done' }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, ...reply } }] }))
  })
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const port = (server.address() as { port: number }).port

function run(args: string[], env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, args, { cwd: workspace, env: { PATH: process.env.PATH ?? '', APERTURE_RUN_REQUEST: requestPath, APERTURE_WORKTREE: workspace, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('exit', (status) => done({ status, stdout, stderr }))
  })
}

const provider = { APERTURE_AGENT_MODEL: 'deepseek-chat', APERTURE_AGENT_MODEL_PROVIDER: 'deepseek', APERTURE_AGENT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/v1/`, APERTURE_AGENT_PROVIDER_API_KEY_ENV: 'APERTURE_AGENT_PROVIDER_API_KEY', APERTURE_AGENT_PROVIDER_API_KEY: secret }

try {
  // A chat provider runs the built-in engine through the single configured entry point.
  const result = await run([join(agents, 'builder.mjs'), '--codex', '/nonexistent/codex'], { ...provider, APERTURE_AGENT_PROVIDER_WIRE_API: 'chat' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /deepseek · wire API chat → chat-builder/u)
  assert.equal(requests.length, 3)
  assert.equal(requests[0].model, 'deepseek-chat')
  assert.deepEqual(requests[0].tools.map((tool) => tool.function.name), ['list_files', 'read_file', 'write_file', 'replace_in_file', 'run_command', 'finish'])
  assert.match(String(requests[0].messages[0].content), /Target product type: application[\s\S]*Declared context: README\.md/u)
  assert.equal(headers.every((header) => header.authorization === `Bearer ${secret}`), true)
  const toolResult = (id: string) => String(requests.flatMap((request) => request.messages).find((message) => message.tool_call_id === id)?.content)
  assert.match(toolResult('c1'), /README\.md/u)
  assert.match(toolResult('c2'), /# Fixture/u)
  assert.match(toolResult('c3'), /outside the worktree/u)
  assert.match(toolResult('c4'), /\.git is managed by the Control Plane/u)
  assert.match(toolResult('c7'), /managed by the Control Plane/u)
  assert.equal(toolResult('c8').includes(secret), false, 'the provider key must not reach a command the model runs')
  assert.doesNotMatch(toolResult('c8'), /APERTURE_AGENT_/u)
  assert.equal(readFileSync(join(workspace, 'src/generated.ts'), 'utf8'), 'export const generated = true\n')
  assert.equal(existsSync(join(workspace, '.git/hooks/pre-commit')), false)
  assert.equal(spawnSync('git', ['-C', workspace, 'rev-parse', '--verify', '--quiet', 'HEAD']).status !== 0, true, 'no commit was made')
  assert.match(result.stdout, /"type":"context_consumed","path":"README\.md"/u)
  assert.match(result.stdout, /"type":"message","summary":"Created src\/generated\.ts\."/u)
  assert.equal(result.stdout.includes(secret) || result.stderr.includes(secret), false)

  // A provider error is surfaced with the provider's message and a failing exit.
  const unreachable = await run([join(agents, 'chat-builder.mjs')], { ...provider, APERTURE_AGENT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/missing`, APERTURE_AGENT_PROVIDER_WIRE_API: 'chat' })
  assert.equal(unreachable.status, 1)
  assert.match(unreachable.stderr, /missing\/chat\/completions → 404/u)

  // At the end of the step budget the model is warned, then offered only finish, so the run still ends with a summary.
  const budget = await run([join(agents, 'chat-builder.mjs')], { ...provider, APERTURE_AGENT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/budget`, APERTURE_AGENT_PROVIDER_WIRE_API: 'chat', APERTURE_BUILDER_MAX_STEPS: '12' })
  assert.equal(budget.status, 0, budget.stderr)
  assert.equal(budgetRequests.length, 12)
  assert.equal(budgetRequests.slice(0, 11).every((request) => request.tools.length === 6), true)
  assert.deepEqual(budgetRequests[11].tools.map((tool) => tool.function.name), ['finish'])
  assert.match(JSON.stringify(budgetRequests[2].messages), /You have 10 steps left/u)
  assert.equal(existsSync(join(workspace, 'ignored-command')), false, 'nothing but finish runs on the last step')
  assert.match(budget.stderr, /step 12 run_command touch ignored-command → rejected/u)
  assert.match(budget.stdout, /"type":"message","summary":"Stopped at the step budget; README reviewed\."/u)

  // Before the runner's deadline the model is warned, a command is cut short so it cannot eat into the time kept for the
  // summary, and then only finish is offered; the run exits in time with a summary marked as partial.
  const clockStartedAt = Date.now()
  const clock = await run([join(agents, 'chat-builder.mjs')], { ...provider, APERTURE_AGENT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/clock`, APERTURE_AGENT_PROVIDER_WIRE_API: 'chat', APERTURE_RUN_DEADLINE: String(clockStartedAt + 4_000) })
  assert.equal(clock.status, 0, clock.stderr)
  assert.ok(Date.now() - clockStartedAt < 4_000, 'the builder exits before the runner would kill it')
  assert.match(JSON.stringify(clockRequests.at(-1)?.messages), /Time is up: this is your last step/u)
  assert.deepEqual(clockRequests.at(-1)?.tools.map((tool) => tool.function.name), ['finish'])
  const slowCommand = clockRequests.at(-1)?.messages.find((message) => message.tool_call_id === 't-slow')
  assert.match(String(slowCommand?.content), /ETIMEDOUT/u, clock.stderr)
  assert.equal(existsSync(join(workspace, 'late-command')), false)
  assert.match(clock.stderr, /asking for finish/u)
  assert.match(clock.stdout, /"type":"message","summary":"Stopped at the time budget; the change may be partial\. README reviewed\."/u)

  clockRequests.length = 0
  const stallStartedAt = Date.now()
  const stall = await run([join(agents, 'chat-builder.mjs')], { ...provider, APERTURE_AGENT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/stall`, APERTURE_AGENT_PROVIDER_WIRE_API: 'chat', APERTURE_RUN_DEADLINE: String(stallStartedAt + 4_000) })
  assert.equal(stall.status, 0, stall.stderr)
  assert.ok(Date.now() - stallStartedAt < 4_000, 'a model that never answers the last step does not hold the builder past the deadline')
  assert.match(stall.stdout, /"type":"message","summary":"Stopped at the time budget before the Builder could summarise its work\. The change is partial/u)

  // "responses" needs Codex, Anthropic needs Claude Code; each is routed only when configured.
  const fakeCodex = join(root, 'fake-codex')
  writeFileSync(fakeCodex, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync('codex-ran', process.argv.slice(2).join(' '))\n`)
  chmodSync(fakeCodex, 0o755)
  const responses = await run([join(agents, 'builder.mjs'), '--codex', fakeCodex], { ...provider, APERTURE_AGENT_MODEL_PROVIDER: 'openai', APERTURE_AGENT_PROVIDER_WIRE_API: 'responses' })
  assert.equal(responses.status, 0, responses.stderr)
  assert.match(readFileSync(join(workspace, 'codex-ran'), 'utf8'), /exec .*model_provider=openai/u)
  const noCodex = await run([join(agents, 'builder.mjs')], { ...provider, APERTURE_AGENT_PROVIDER_WIRE_API: 'responses' })
  assert.equal(noCodex.status, 2)
  assert.match(noCodex.stdout, /Builder not started: .*needs the Codex engine/u)
  const noClaude = await run([join(agents, 'builder.mjs')], { ...provider, APERTURE_AGENT_MODEL_PROVIDER: 'anthropic', APERTURE_AGENT_PROVIDER_WIRE_API: 'chat' })
  assert.equal(noClaude.status, 2)
  assert.match(noClaude.stdout, /needs the Claude Code engine/u)
  const unconfigured = await run([join(agents, 'builder.mjs')], {})
  assert.equal(unconfigured.status, 2)
  assert.match(unconfigured.stdout, /No LLM provider is configured/u)

  console.log('chat builder smoke passed · 3 model turns · worktree-confined tools · key kept from commands · engine routed by provider · step budget ends in finish · time budget ends in finish before the deadline')
} finally {
  server.closeAllConnections()
  server.close()
  rmSync(root, { recursive: true, force: true })
}
