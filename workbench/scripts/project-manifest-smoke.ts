// The project manifest's schema versions: v1 stays as it was, digest included, and cannot carry builder settings; v2
// adds `builder`, whose defaults (no shell for the chat engine) are written into the parsed manifest and its digest.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProjectManifest } from '../server/project-manifest.ts'
import { sha256 } from '../server/security.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-project-manifest-'))
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
const refused = (code: string, message?: RegExp) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code && (!message || message.test(error.message))
const base = { productType: 'application', context: { required: ['README.md'], allowed: ['README.md'] }, checks: [{ name: 'unit', kind: 'test', command: ['node', '--test'], timeoutMs: 20_000 }], policy: { maximumRisk: 'medium', allowUnisolatedRuntime: true } }

execFileSync('git', ['init', '--quiet', '--initial-branch=main', root])
git('config', 'user.name', 'Aperture Test')
git('config', 'user.email', 'test@aperture.invalid')
mkdirSync(join(root, '.aperture'))
writeFileSync(join(root, 'README.md'), '# Fixture\n')
function load(manifest: object) {
  writeFileSync(join(root, '.aperture/project.json'), JSON.stringify(manifest))
  git('add', '-A')
  git('commit', '--quiet', '--allow-empty', '-m', 'manifest')
  return loadProjectManifest(root, git('rev-parse', 'HEAD'))
}

try {
  const v1 = load({ schemaVersion: 'aperture.project.v1', ...base })
  assert.equal('builder' in v1.manifest, false, 'a v1 manifest parses to what it always did')
  assert.equal(v1.digest, `sha256:${sha256(JSON.stringify({ schemaVersion: 'aperture.project.v1', productType: 'application', context: base.context, checks: base.checks, testPaths: [], evaluation: { profile: 'application_checks', thresholds: [] }, policy: base.policy }))}`, 'so its digest is unchanged')
  assert.throws(() => load({ schemaVersion: 'aperture.project.v1', ...base, builder: { allowShell: true } }), refused('invalid_project_manifest', /requires schemaVersion aperture\.project\.v2/u))

  const v2 = load({ schemaVersion: 'aperture.project.v2', ...base })
  assert.deepEqual(v2.manifest.builder, { allowShell: false }, 'no shell unless the manifest says so')
  assert.equal(v2.manifest.schemaVersion, 'aperture.project.v2')
  const shell = load({ schemaVersion: 'aperture.project.v2', ...base, builder: { allowShell: true } })
  assert.deepEqual(shell.manifest.builder, { allowShell: true })
  assert.notEqual(shell.digest, v2.digest, 'the digest records whether a shell was allowed')

  assert.throws(() => load({ schemaVersion: 'aperture.project.v2', ...base, builder: { allowShell: 'yes' } }), refused('invalid_project_manifest', /builder\.allowShell must be boolean/u))
  assert.throws(() => load({ schemaVersion: 'aperture.project.v2', ...base, builder: { allowShell: true, network: true } }), refused('invalid_project_manifest', /Unknown builder settings: network/u))
  assert.throws(() => load({ schemaVersion: 'aperture.project.v2', ...base, builder: [] }), refused('invalid_project_manifest'))
  assert.throws(() => load({ schemaVersion: 'aperture.project.v3', ...base }), refused('unsupported_project_manifest'))

  console.log('project manifest smoke passed · v1 unchanged · v2 builder.allowShell defaults to no shell')
} finally {
  rmSync(root, { recursive: true, force: true })
}
