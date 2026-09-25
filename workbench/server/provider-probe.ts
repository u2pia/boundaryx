/**
 * One small request to the configured LLM provider, so an Owner learns that the base URL, model or key is wrong
 * from the settings page rather than from a failed run ten minutes later. It calls the same endpoint the engine
 * would: Anthropic Messages, OpenAI-compatible Chat Completions, or the Responses API. The key goes only into the
 * request header; anything the provider echoes back is truncated and scrubbed of it before it is returned.
 * An Anthropic provider without a key runs on the local Claude Code and its own login, so that is what is asked.
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { localClaude } from '../scripts/agents/local-claude.mjs'

export type ProviderProbeInput = { providerId: string; model: string; baseUrl: string; wireApi: 'responses' | 'chat'; apiKey?: string }

export type ProviderProbeResult = {
  ok: boolean
  engine: 'anthropic' | 'chat' | 'responses' | 'claude-code'
  endpoint: string
  status?: number
  latencyMs: number
  /** The start of the model's reply when it answered. */
  reply?: string
  /** A plain-language reason when it did not. */
  error?: string
  detail?: string
}

const PROMPT = 'Reply with the single word OK.'

// Mirrors scripts/agents/builder.mjs, which picks the engine from the same fields at each run.
function isAnthropic(input: ProviderProbeInput) {
  let host = ''
  try { host = new URL(input.baseUrl).hostname } catch { /* validated by the caller */ }
  return input.providerId.trim() === 'anthropic' || /(^|\.)anthropic\.com$/u.test(host)
}

function scrub(text: string, apiKey?: string) {
  const clipped = text.replace(/\s+/gu, ' ').trim().slice(0, 300)
  return apiKey ? clipped.split(apiKey).join('***') : clipped
}

function replyOf(engine: ProviderProbeResult['engine'], body: unknown): string | undefined {
  const value = body as Record<string, unknown> | undefined
  if (!value) return undefined
  if (engine === 'anthropic') return (value.content as { text?: string }[] | undefined)?.find((part) => typeof part.text === 'string')?.text
  if (engine === 'chat') return (value.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content ?? undefined
  if (typeof value.output_text === 'string') return value.output_text
  for (const item of (value.output as { content?: { text?: string }[] }[] | undefined) ?? []) {
    const text = item.content?.find((part) => typeof part.text === 'string')?.text
    if (text) return text
  }
  return undefined
}

function reasonFor(status: number) {
  if (status === 401 || status === 403) return 'API Key 无效，或没有这个模型的权限'
  if (status === 404) return 'Base URL 或模型名不对（接口返回 404）'
  if (status === 429) return '被限流或额度用完（429）'
  if (status >= 500) return `服务商那边出错（${status}）`
  return `接口返回 ${status}`
}

// The variables Claude Code needs to find its login and the network, and no more: the server's own secrets stay out.
const CLAUDE_ENVIRONMENT = ['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']

/** One print-mode turn of the local Claude Code, configured the way claude-builder runs it. */
async function probeLocalClaude(input: ProviderProbeInput, timeoutMs: number): Promise<ProviderProbeResult> {
  const executable = localClaude() as string | undefined
  const started = Date.now()
  const result = (fields: Partial<ProviderProbeResult>): ProviderProbeResult => ({ ok: false, engine: 'claude-code', endpoint: executable ?? 'claude', latencyMs: Date.now() - started, ...fields })
  if (!executable) return result({ error: '本机没有找到 Claude Code：安装后再试，或填写 API Key 直连 Anthropic' })
  const environment: Record<string, string> = Object.fromEntries(CLAUDE_ENVIRONMENT.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []))
  if (input.baseUrl.trim()) environment.ANTHROPIC_BASE_URL = input.baseUrl.trim()
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: Error }>((done) => {
    const child = spawn(executable, ['--print', '--output-format', 'json', '--max-turns', '1', ...(input.model.trim() ? ['--model', input.model.trim()] : [])], { cwd: tmpdir(), env: environment })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdin.on('error', () => {})
    child.stdin.end(PROMPT)
    child.on('error', (error) => { clearTimeout(timer); done({ code: null, stdout, stderr, timedOut, error }) })
    child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr, timedOut }) })
  })
  if (output.error) return result({ error: 'Claude Code 启动失败', detail: scrub(output.error.message) })
  if (output.timedOut) return result({ error: `等待超时：Claude Code 没有在 ${Math.round(timeoutMs / 1000)} 秒内应答` })
  let payload: { result?: unknown; is_error?: boolean; subtype?: string } | undefined
  try { payload = JSON.parse(output.stdout) } catch { /* reported below */ }
  if (output.code !== 0 || !payload || payload.is_error || typeof payload.result !== 'string') {
    return result({ error: 'Claude Code 应答失败：检查它的登录、~/.claude/settings.json 里的网关和模型名', detail: scrub(typeof payload?.result === 'string' ? payload.result : output.stderr || output.stdout) })
  }
  return result({ ok: true, reply: scrub(payload.result).slice(0, 80) })
}

export async function probeAgentProvider(input: ProviderProbeInput, options: { timeoutMs?: number } = {}): Promise<ProviderProbeResult> {
  const base = input.baseUrl.trim().replace(/\/+$/u, '')
  if (isAnthropic(input) && !input.apiKey) return probeLocalClaude(input, options.timeoutMs ?? 60_000)
  const engine: ProviderProbeResult['engine'] = isAnthropic(input) ? 'anthropic' : input.wireApi
  const bearer = input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}
  const request = engine === 'anthropic'
    ? { endpoint: `${base}/v1/messages`, headers: { 'anthropic-version': '2023-06-01', ...(input.apiKey ? { 'x-api-key': input.apiKey } : {}) }, body: { model: input.model, max_tokens: 16, messages: [{ role: 'user', content: PROMPT }] } }
    : engine === 'chat'
      ? { endpoint: `${base}/chat/completions`, headers: bearer, body: { model: input.model, messages: [{ role: 'user', content: PROMPT }] } }
      : { endpoint: `${base}/responses`, headers: bearer, body: { model: input.model, input: PROMPT } }
  const started = Date.now()
  const result = (fields: Partial<ProviderProbeResult>): ProviderProbeResult => ({ ok: false, engine, endpoint: request.endpoint, latencyMs: Date.now() - started, ...fields })
  let response: Response
  try {
    response = await fetch(request.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...request.headers }, body: JSON.stringify(request.body), signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    const cause = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error)
    return result({ error: timedOut ? '等待超时：服务商没有在 30 秒内应答' : '连不上 Base URL：检查地址、网络或代理', detail: scrub(cause, input.apiKey) })
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) return result({ status: response.status, error: reasonFor(response.status), detail: scrub(text, input.apiKey) })
  let body: unknown
  try { body = JSON.parse(text) } catch { return result({ status: response.status, error: '返回的不是 JSON：Base URL 可能指向了网页而不是 API', detail: scrub(text, input.apiKey) }) }
  const reply = replyOf(engine, body)
  if (reply === undefined) return result({ status: response.status, error: '接口应答了，但读不到模型回复：检查 Wire API 是否选对', detail: scrub(text, input.apiKey) })
  return result({ ok: true, status: response.status, reply: scrub(reply, input.apiKey).slice(0, 80) })
}
