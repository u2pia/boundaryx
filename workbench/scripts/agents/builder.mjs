import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The one Builder the server is configured with. Which engine runs follows the provider saved in the Control
// Plane, so switching models never needs a restart or a different server command:
//   Anthropic provider         → claude-builder (needs --claude <path>)
//   wire API "responses"       → codex-builder  (needs --codex <path>)
//   wire API "chat"            → chat-builder, built in, any OpenAI-compatible Chat Completions endpoint
// Usage: node builder.mjs [--codex /path/to/codex] [--claude /path/to/claude]
const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const cli = {}
for (let index = 0; index < argv.length; index += 2) {
  const flag = argv[index]
  if ((flag !== '--codex' && flag !== '--claude') || !argv[index + 1]) {
    console.error(`builder: unexpected argument ${flag}; usage: builder.mjs [--codex <path>] [--claude <path>]`)
    process.exit(2)
  }
  cli[flag.slice(2)] = argv[index + 1]
}

const providerId = process.env.APERTURE_AGENT_MODEL_PROVIDER ?? ''
const wireApi = process.env.APERTURE_AGENT_PROVIDER_WIRE_API ?? ''
const anthropic = providerId === 'anthropic' || /(^|\.)anthropic\.com$/u.test(safeHost(process.env.APERTURE_AGENT_PROVIDER_BASE_URL))

function safeHost(url) {
  try {
    return url ? new URL(url).hostname : ''
  } catch {
    return ''
  }
}

let engine
let args
if (anthropic) {
  if (!cli.claude) fail(`Provider ${providerId || 'anthropic'} uses the Anthropic API, which needs the Claude Code engine; start the server with --claude <path> in CONTROL_PLANE_AGENT_ARGS_JSON, or choose an OpenAI-compatible provider with wire API "chat".`)
  engine = 'claude-builder'
  args = [resolve(here, 'claude-builder.mjs'), cli.claude]
} else if (wireApi === 'responses') {
  if (!cli.codex) fail(`Provider ${providerId} uses wire API "responses", which needs the Codex engine; start the server with --codex <path> in CONTROL_PLANE_AGENT_ARGS_JSON, or switch the provider to wire API "chat" if it offers Chat Completions.`)
  engine = 'codex-builder'
  args = [resolve(here, 'codex-builder.mjs'), cli.codex]
} else if (wireApi === 'chat' || !wireApi) {
  if (!process.env.APERTURE_AGENT_MODEL || !process.env.APERTURE_AGENT_PROVIDER_BASE_URL) fail('No LLM provider is configured: the Owner sets one under Integrations → Builder Agent LLM Provider.')
  engine = 'chat-builder'
  // Node's fetch ignores HTTPS_PROXY unless asked to honour it, and a corporate network may need it.
  args = ['--use-env-proxy', resolve(here, 'chat-builder.mjs')]
} else {
  fail(`Unsupported wire API "${wireApi}"`)
}

function fail(message) {
  console.error(`builder: ${message}`)
  console.log(JSON.stringify({ type: 'message', summary: `Builder not started: ${message}` }))
  process.exit(2)
}

console.error(`[builder] provider ${providerId || '(none)'} · wire API ${wireApi || '(none)'} → ${engine}`)
const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: 'inherit', env: process.env })
// A cancelled or timed-out run signals this process; the engine must stop with it rather than keep editing.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal))
child.on('error', (error) => {
  console.error(error.message)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
