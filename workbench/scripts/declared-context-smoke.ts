// The declared context the Control Plane compiles for a Builder: taken from the base revision, required files first,
// cut to the prompt budget on a UTF-8 character boundary with the cut recorded, and a Run refused when a required
// file is missing or the required files alone do not fit.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileDeclaredContext, declaredContextSummary, utf8Prefix } from '../server/declared-context.ts'
import { sha256 } from '../server/security.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-declared-context-'))
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
const refused = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code

try {
  // '规' is three bytes: a limit inside it backs off to the character before.
  assert.equal(utf8Prefix(Buffer.from('ab规则'), 4).toString('utf8'), 'ab')
  assert.equal(utf8Prefix(Buffer.from('ab规则'), 5).toString('utf8'), 'ab规')
  assert.equal(utf8Prefix(Buffer.from('ab'), 10).toString('utf8'), 'ab')

  execFileSync('git', ['init', '--quiet', '--initial-branch=main', root])
  git('config', 'user.name', 'Aperture Test')
  git('config', 'user.email', 'test@aperture.invalid')
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'RULES.md'), '规则'.repeat(10))
  writeFileSync(join(root, 'docs/guide.md'), '指南'.repeat(10))
  writeFileSync(join(root, 'docs/extra.md'), 'extra\n')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  // A later commit, like a previous Builder's head, does not change what a Run on the base is given.
  writeFileSync(join(root, 'RULES.md'), 'rewritten')
  git('commit', '--quiet', '-am', 'later')

  const paths = ['docs/guide.md', 'docs/extra.md', 'RULES.md', 'docs/absent.md']
  const whole = compileDeclaredContext(root, baseSha, paths, ['RULES.md'])
  assert.deepEqual(whole.entries.map((entry) => entry.path), ['RULES.md', 'docs/guide.md', 'docs/extra.md'], 'required files first, then declaration order')
  assert.equal(whole.entries[0].content, '规则'.repeat(10), 'content comes from the base revision')
  assert.equal(whole.entries[0].injectedDigest, `sha256:${sha256('规则'.repeat(10))}`)
  assert.equal(whole.entries.every((entry) => entry.truncatedAt === null && entry.injectedDigest === entry.fileDigest), true)
  assert.deepEqual(whole.omitted, [{ path: 'docs/absent.md', required: false, reason: 'missing' }])

  // 60 required bytes, then 20 of guide's 60, cut on a character boundary at 18, and the 2 bytes left to extra.
  const cut = compileDeclaredContext(root, baseSha, paths, ['RULES.md'], 80)
  const guide = cut.entries.find((entry) => entry.path === 'docs/guide.md')!
  assert.deepEqual([guide.fileBytes, guide.injectedBytes, guide.truncatedAt, guide.content], [60, 18, 18, '指南指南指南'])
  assert.equal(guide.fileDigest, `sha256:${sha256('指南'.repeat(10))}`)
  assert.equal(guide.injectedDigest, `sha256:${sha256('指南指南指南')}`)
  assert.deepEqual(cut.entries.map((entry) => [entry.path, entry.truncatedAt]), [['RULES.md', null], ['docs/guide.md', 18], ['docs/extra.md', 2]])
  assert.equal('content' in declaredContextSummary(cut).entries[0], false, 'events carry digests, not contents')

  // With the budget spent exactly, a later file is left out and says why.
  const spent = compileDeclaredContext(root, baseSha, paths, ['RULES.md'], 78)
  assert.deepEqual(spent.entries.map((entry) => entry.path), ['RULES.md', 'docs/guide.md'])
  assert.deepEqual(spent.omitted, [{ path: 'docs/extra.md', required: false, reason: 'budget' }, { path: 'docs/absent.md', required: false, reason: 'missing' }])

  assert.throws(() => compileDeclaredContext(root, baseSha, paths, ['RULES.md'], 59), refused('required_context_over_budget'))
  assert.throws(() => compileDeclaredContext(root, baseSha, paths, ['RULES.md', 'docs/absent.md']), refused('required_context_missing'))
  assert.throws(() => compileDeclaredContext(root, baseSha, ['docs'], ['docs']), refused('required_context_missing'), 'a directory is not a context file')

  console.log('declared context smoke passed · base revision, budget cut on a character boundary, required context enforced')
} finally {
  rmSync(root, { recursive: true, force: true })
}
