// The project manifest's schema versions: v1 stays as it was, digest included, and cannot carry builder settings; v2
// adds `builder`, whose defaults (no shell for the chat engine) are written into the parsed manifest and its digest.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProjectManifest, validateIntentVerifiedBy } from '../server/project-manifest.ts'
import { bindProjectSkills, PROJECT_SKILL_MAX_BYTES } from '../server/project-skills.ts'
import { sha256 } from '../server/security.ts'
import type { IntentVersion } from '../server/types.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-project-manifest-'))
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
const refused = (code: string, message?: RegExp) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code && (!message || message.test(error.message))
const base = { productType: 'application', context: { required: ['README.md'], allowed: ['README.md'] }, checks: [{ name: 'unit', kind: 'test', command: ['node', '--test'], timeoutMs: 20_000 }], policy: { maximumRisk: 'medium', allowUnisolatedRuntime: true } }

execFileSync('git', ['init', '--quiet', '--initial-branch=main', root])
git('config', 'user.name', 'Aperture Test')
git('config', 'user.email', 'test@aperture.invalid')
mkdirSync(join(root, '.aperture'))
mkdirSync(join(root, '.aperture/skills'))
writeFileSync(join(root, 'README.md'), '# Fixture\n')
writeFileSync(join(root, '.aperture/skills/review-change.md'), '# Review change\n')
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

  const withSkills = load({ schemaVersion: 'aperture.project.v2', ...base, skills: [{ name: 'review-change', path: '.aperture/skills/review-change.md', description: 'Review a proposed change against its Intent and Evidence.' }] })
  assert.deepEqual(withSkills.manifest.skills, [{ name: 'review-change', path: '.aperture/skills/review-change.md', description: 'Review a proposed change against its Intent and Evidence.' }])
  assert.notEqual(withSkills.digest, v2.digest, 'the manifest digest records the governed Skill catalog')
  assert.match(bindProjectSkills(root, withSkills.baseSha, withSkills.manifest.skills)[0].contentDigest, /^sha256:[0-9a-f]{64}$/u)
  assert.throws(() => bindProjectSkills(root, withSkills.baseSha, [{ name: 'missing', path: '.aperture/skills/missing.md', description: 'Missing.' }]), refused('project_skill_missing'))
  writeFileSync(join(root, '.aperture/skills/too-large.md'), 'x'.repeat(PROJECT_SKILL_MAX_BYTES + 1))
  const tooLarge = load({ schemaVersion: 'aperture.project.v2', ...base, skills: [{ name: 'too-large', path: '.aperture/skills/too-large.md', description: 'Too large.' }] })
  assert.throws(() => bindProjectSkills(root, tooLarge.baseSha, tooLarge.manifest.skills), refused('project_skill_too_large'))

  const verifiedIntent = {
    id: 'WI-1:v1',
    riskLevel: 'medium',
    acceptanceCriteria: [{
      id: 'WI-1:v1:AC-1',
      ordinal: 1,
      statement: 'the unit suite passes',
      criticality: 'critical',
      verificationType: 'deterministic',
      verifiedBy: ['unit'],
    }],
  } as IntentVersion
  assert.doesNotThrow(() => validateIntentVerifiedBy(v2.manifest, verifiedIntent), 'deterministic criteria may bind a declared test check')
  assert.throws(() => validateIntentVerifiedBy(v2.manifest, {
    ...verifiedIntent,
    acceptanceCriteria: [{ ...verifiedIntent.acceptanceCriteria[0], verifiedBy: ['made-up-check'] }],
  }), refused('intent_verified_by_invalid', /declares missing check made-up-check/u))
  assert.throws(() => validateIntentVerifiedBy(v2.manifest, {
    ...verifiedIntent,
    acceptanceCriteria: [{ ...verifiedIntent.acceptanceCriteria[0], verificationType: 'model', verifiedBy: ['unit'] }],
  }), refused('intent_verified_by_invalid', /model.*cannot be verified by unit \(test\)/u))

  assert.throws(() => load({ schemaVersion: 'aperture.project.v2', ...base, builder: { allowShell: 'yes' } }), refused('invalid_project_manifest', /builder\.allowShell must be boolean/u))
  assert.throws(() => load({ schemaVersion: 'aperture.project.v2', ...base, builder: { allowShell: true, network: true } }), refused('invalid_project_manifest', /Unknown builder settings: network/u))
  assert.throws(() => load({ schemaVersion: 'aperture.project.v2', ...base, builder: [] }), refused('invalid_project_manifest'))
  assert.throws(() => load({ schemaVersion: 'aperture.project.v2', ...base, skills: [{ name: 'same', path: '.aperture/skills/a.md', description: 'a' }, { name: 'same', path: '.aperture/skills/b.md', description: 'b' }] }), refused('invalid_project_manifest', /Duplicate skill name/u))
  assert.throws(() => load({ schemaVersion: 'aperture.project.v2', ...base, skills: [{ name: 'outside-policy', path: 'docs/outside-skill.md', description: 'Outside the governed policy tree.' }] }), refused('invalid_project_manifest', /must be under \.aperture\/skills\//u))
  assert.throws(() => load({ schemaVersion: 'aperture.project.v2', ...base, skills: [{ name: 'bad', path: '../outside.md', description: 'bad' }] }), refused('invalid_project_manifest', /normalized repository-relative path/u))
  assert.throws(() => load({ schemaVersion: 'aperture.project.v3', ...base }), refused('unsupported_project_manifest'))

  console.log('project manifest smoke passed · v1 unchanged · v2 builder.allowShell defaults to no shell · Skills catalog and Intent check bindings validated')
} finally {
  rmSync(root, { recursive: true, force: true })
}
