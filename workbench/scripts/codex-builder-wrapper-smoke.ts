import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'aperture-codex-wrapper-'))
const workspace = join(root, 'workspace')
const requestPath = join(root, 'request.json')
const fakeCodex = join(root, 'fake-codex')
const wrapper = resolve(dirname(fileURLToPath(import.meta.url)), 'agents/codex-builder.mjs')

mkdirSync(workspace)
writeFileSync(join(workspace, 'README.md'), '# Fixture\n')
writeFileSync(requestPath, JSON.stringify({ runId: 'RUN-WRAPPER', workItem: { title: 'Build fixture', productType: 'application' }, intent: { goal: 'Create generated.ts', constraints: ['offline'], acceptanceCriteria: [{ statement: 'File exists', criticality: 'critical', verificationType: 'deterministic' }] }, declaredContextPaths: ['README.md'], declaredContext: { baseSha: 'a'.repeat(40), budgetBytes: 200000, entries: [{ path: 'README.md', required: true, fileBytes: 20, fileDigest: 'sha256:x', injectedBytes: 20, injectedDigest: 'sha256:x', truncatedAt: null, content: '# Reviewed fixture\n' }], omitted: [{ path: 'docs/big.md', required: false, reason: 'budget' }] } }))
writeFileSync(fakeCodex, `#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from 'node:fs'\nconst args = process.argv.slice(2)\nwriteFileSync('../codex-args.json', JSON.stringify(args))\nconst outputIndex = args.indexOf('-o')\nconst prompt = readFileSync(0, 'utf8')\nif (!prompt.includes('Target product type: application') || !prompt.includes('# Reviewed fixture')) process.exit(3)\nwriteFileSync('generated.ts', 'export const generated = true\\n')\nif (outputIndex >= 0) writeFileSync(args[outputIndex + 1], 'Fixture completed')\nconsole.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message' } }))\n`)
chmodSync(fakeCodex, 0o755)

try {
  const result = spawnSync(process.execPath, [wrapper, fakeCodex], { cwd: workspace, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', APERTURE_RUN_REQUEST: requestPath, APERTURE_WORKTREE: workspace } })
  assert.equal(result.status, 0, result.stderr)
assert.doesNotMatch(result.stdout, /"type":"context_consumed"/u, 'declared context is recorded by the Control Plane, which injected it')
assert.match(result.stdout, /"type":"message"/u)
const capturedArgs = JSON.parse(readFileSync(join(root, 'codex-args.json'), 'utf8') as string) as string[]
assert.equal(capturedArgs.includes('--approve-for-me'), true)
assert.equal(capturedArgs.includes('--sandbox'), false)
  assert.match(readFileSync(join(workspace, 'generated.ts'), 'utf8'), /generated = true/u)

  // Claude Code runs with only the operator's settings and without any tool that runs code or MCP server, and what it
  // read is taken from its event stream: a Read or a content Grep whose result came back, not a refused one.
  const fakeClaude = join(root, 'fake-claude')
  const toolUse = (id: string, name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
  const toolResult = (id: string, isError = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } })
  const stream = [
    toolUse('t1', 'Read', { file_path: join(workspace, 'README.md'), offset: 10, limit: 20 }), toolResult('t1'),
    toolUse('t2', 'Read', { file_path: join(workspace, 'secret.md') }), toolResult('t2', true),
    toolUse('t3', 'Grep', { pattern: 'x', path: join(workspace, 'src') }), toolResult('t3'),
    toolUse('t4', 'Grep', { pattern: 'x', output_mode: 'content' }), toolResult('t4'),
    toolUse('t5', 'Read', { file_path: '/etc/hosts' }), toolResult('t5'),
    toolUse('t6', 'Read', { file_path: join(workspace, 'README.md'), offset: 10, limit: 20 }), toolResult('t6'),
    toolUse('t7', 'Read', { file_path: join(workspace, 'never.md') }),
    JSON.stringify({ type: 'result', result: 'Claude fixture completed' }),
  ]
  writeFileSync(fakeClaude, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'\nwriteFileSync('../claude-args.json', JSON.stringify({ args: process.argv.slice(2), memory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY }))\nconsole.log(${JSON.stringify(stream.join('\n'))})\n`)
  chmodSync(fakeClaude, 0o755)
  const claudeWrapper = resolve(dirname(wrapper), 'claude-builder.mjs')
  const claudeEnv = { PATH: process.env.PATH ?? '', APERTURE_RUN_REQUEST: requestPath, APERTURE_WORKTREE: workspace }
  const claude = spawnSync(process.execPath, [claudeWrapper, fakeClaude, '--max-turns', '40'], { cwd: workspace, encoding: 'utf8', env: claudeEnv })
  assert.equal(claude.status, 0, claude.stderr)
  const claudeRun = JSON.parse(readFileSync(join(root, 'claude-args.json'), 'utf8')) as { args: string[]; memory?: string }
  const after = (flag: string) => claudeRun.args[claudeRun.args.indexOf(flag) + 1]
  assert.equal(after('--setting-sources'), 'user', 'project and local settings in the worktree are not loaded')
  assert.equal(after('--tools'), 'Read,Write,Edit,Glob,Grep', 'Bash is not in the engine at all')
  assert.equal(after('--disallowedTools'), 'mcp__*')
  assert.deepEqual(JSON.parse(after('--settings')), { disableAllHooks: true })
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands']) assert.ok(claudeRun.args.includes(flag), flag)
  assert.equal(claudeRun.args.includes('--mcp-config'), false, 'no MCP server is configured')
  assert.deepEqual(claudeRun.args.slice(-2), ['--max-turns', '40'], 'other configured arguments still pass through')
  assert.equal(claudeRun.memory, '1')
  const reads = claude.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.type === 'context_consumed')
  assert.deepEqual(reads, [
    { type: 'context_consumed', source: 'engine_stream', path: 'README.md', tool: 'Read', offset: 10, limit: 20 },
    { type: 'context_consumed', source: 'engine_stream', path: '.', tool: 'Grep' },
    { type: 'context_consumed', source: 'engine_stream', path: '/etc/hosts', tool: 'Read' },
  ], 'a failed read, a file-list Grep, a repeated read and a read with no result are not reported')
  for (const override of ['--tools', '--allowedTools=Bash', '--setting-sources', '--mcp-config', '--dangerously-skip-permissions']) {
    const refused = spawnSync(process.execPath, [claudeWrapper, fakeClaude, override, 'x'], { cwd: workspace, encoding: 'utf8', env: claudeEnv })
    assert.equal(refused.status, 2, `${override} is refused`)
    assert.match(refused.stderr, /sets .* itself/u)
  }

  // A CLI that is still working when the run's deadline approaches is stopped by the wrapper, which hands the edits
  // over marked as partial instead of letting the runner kill the whole run and throw them away.
  const hangingCli = join(root, 'hanging-cli')
  writeFileSync(hangingCli, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'\nconst args = process.argv.slice(2)\nconst outputIndex = args.indexOf('-o')\nwriteFileSync('partial.ts', 'export const partial = true\\n')\nif (outputIndex >= 0) writeFileSync(args[outputIndex + 1], 'Wrote partial.ts')\nsetTimeout(() => writeFileSync('late.ts', ''), 60_000)\n`)
  chmodSync(hangingCli, 0o755)
  for (const [engine, script, detail] of [['Codex', 'codex-builder.mjs', / Its last message: Wrote partial\.ts/u], ['Claude Code', 'claude-builder.mjs', /criterion\.$/u]] as const) {
    rmSync(join(root, 'codex-last-message.txt'), { force: true })
    const startedAt = Date.now()
    const stopped = spawnSync(process.execPath, [resolve(dirname(wrapper), script), hangingCli], { cwd: workspace, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', APERTURE_RUN_REQUEST: requestPath, APERTURE_WORKTREE: workspace, APERTURE_RUN_DEADLINE: String(startedAt + 3_000) } })
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.ok(Date.now() - startedAt < 3_000, `${engine} is stopped before the runner would kill the run`)
    const message = stopped.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; summary?: string; stopped?: string }).filter((line) => line.type === 'message')
    assert.equal(message.length, 1, stopped.stdout)
    assert.equal(message[0].stopped, 'time_budget')
    assert.match(message[0].summary ?? '', new RegExp(`^Stopped at the time budget: ${engine} was stopped before it finished, so the change is partial: review it against every acceptance criterion\\.`, 'u'))
    assert.match(message[0].summary ?? '', detail)
    assert.match(readFileSync(join(workspace, 'partial.ts'), 'utf8'), /partial = true/u)
    rmSync(join(workspace, 'partial.ts'))
  }
  console.log('codex builder wrapper smoke passed · declared context injected · claude hardened, reads taken from its stream · workspace edited · codex and claude stopped before the deadline with a partial summary')
} finally {
  rmSync(root, { recursive: true, force: true })
}
