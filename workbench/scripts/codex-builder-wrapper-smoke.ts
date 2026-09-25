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
writeFileSync(requestPath, JSON.stringify({ runId: 'RUN-WRAPPER', workItem: { title: 'Build fixture', productType: 'application' }, intent: { goal: 'Create generated.ts', constraints: ['offline'], acceptanceCriteria: [{ statement: 'File exists', criticality: 'critical', verificationType: 'deterministic' }] }, declaredContextPaths: ['README.md'] }))
writeFileSync(fakeCodex, `#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from 'node:fs'\nconst args = process.argv.slice(2)\nwriteFileSync('../codex-args.json', JSON.stringify(args))\nconst outputIndex = args.indexOf('-o')\nconst prompt = readFileSync(0, 'utf8')\nif (!prompt.includes('Target product type: application')) process.exit(3)\nwriteFileSync('generated.ts', 'export const generated = true\\n')\nif (outputIndex >= 0) writeFileSync(args[outputIndex + 1], 'Fixture completed')\nconsole.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message' } }))\n`)
chmodSync(fakeCodex, 0o755)

try {
  const result = spawnSync(process.execPath, [wrapper, fakeCodex], { cwd: workspace, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', APERTURE_RUN_REQUEST: requestPath, APERTURE_WORKTREE: workspace } })
  assert.equal(result.status, 0, result.stderr)
assert.match(result.stdout, /"type":"context_consumed"/u)
assert.match(result.stdout, /"type":"message"/u)
const capturedArgs = JSON.parse(readFileSync(join(root, 'codex-args.json'), 'utf8') as string) as string[]
assert.equal(capturedArgs.includes('--approve-for-me'), true)
assert.equal(capturedArgs.includes('--sandbox'), false)
  assert.match(readFileSync(join(workspace, 'generated.ts'), 'utf8'), /generated = true/u)

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
  console.log('codex builder wrapper smoke passed · declared context injected · workspace edited · codex and claude stopped before the deadline with a partial summary')
} finally {
  rmSync(root, { recursive: true, force: true })
}
