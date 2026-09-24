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
  console.log('codex builder wrapper smoke passed · declared context injected · workspace edited')
} finally {
  rmSync(root, { recursive: true, force: true })
}
