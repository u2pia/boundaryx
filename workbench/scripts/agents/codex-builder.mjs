import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { progress } from './progress.mjs'
import { cliTimeoutMs, partialMessage, stoppedAtDeadline } from './run-deadline.mjs'
import { declaredContextSections, taskPrompt } from './run-request.mjs'

const [codexExecutable, ...configuredArgs] = process.argv.slice(2)
const requestPath = process.env.APERTURE_RUN_REQUEST
const worktreePath = process.env.APERTURE_WORKTREE

if (!codexExecutable || !requestPath || !worktreePath) {
  console.error('codex-builder requires a Codex executable, APERTURE_RUN_REQUEST and APERTURE_WORKTREE')
  process.exit(2)
}

const request = JSON.parse(readFileSync(requestPath, 'utf8'))
const contextSections = declaredContextSections(request)
const prompt = `${taskPrompt(request)}

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
