// Code a Run executes (the Builder, and the head revision's checks) must not get the Control Plane's own Git commands
// to run anything for it. Drives runs whose Builder plants hooks and an fsmonitor command in the repository's Git
// directory and repoints the worktree's `.git` file, and whose check plants an fsmonitor command, and checks that the
// run still commits exactly the change while none of the planted commands ever runs. A Builder confined by Seatbelt
// cannot write the repository's Git directory at all, and can still read it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../server/database.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { LocalEvidenceStore } from '../server/local-evidence-store.ts'
import { LocalRunPostprocessor } from '../server/local-run-postprocessor.ts'
import { seatbeltAvailable } from '../server/seatbelt.ts'
import { GIT_NO_EXEC } from '../server/worktree-git.ts'
import { useProjectRepository } from './fixtures.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-git-escalation-'))
const dataDirectory = join(root, 'data')
const repositoryPath = join(root, 'repository')
const agentScript = join(root, 'agent.mjs')
const markers = join(root, 'markers')
mkdirSync(dataDirectory)
mkdirSync(markers)
const database = new ControlPlaneDatabase(join(dataDirectory, 'control-plane.db'), resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations'))
// The test's own Git commands must not trip what the runs plant either.
const git = (...args: string[]) => execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()

// Each planted command leaves a marker named after who planted it; no marker may ever appear.
const plantedCommand = (name: string) => {
  const path = join(root, `${name}.sh`)
  writeFileSync(path, `#!/bin/sh\ntouch ${JSON.stringify(join(markers, name))}\n`, { mode: 0o755 })
  return path
}
const planted = { hook: plantedCommand('builder-hook'), fsmonitor: plantedCommand('builder-fsmonitor'), check: plantedCommand('check-fsmonitor') }

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--quiet', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture Test')
git('config', 'user.email', 'test@aperture.invalid')
mkdirSync(join(repositoryPath, '.aperture'))
writeFileSync(join(repositoryPath, 'README.md'), '# Fixture\n')
// The check is head code run on the host: it plants an fsmonitor command through the worktree's Git.
writeFileSync(join(repositoryPath, 'check.mjs'), `import { execFileSync } from 'node:child_process'\ntry { execFileSync('git', ['config', 'core.fsmonitor', ${JSON.stringify(planted.check)}]) } catch {}\n`)
writeFileSync(join(repositoryPath, '.aperture/project.json'), JSON.stringify({ schemaVersion: 'aperture.project.v1', productType: 'application', context: { required: ['README.md'], allowed: ['README.md'] }, checks: [{ name: 'unit', kind: 'test', command: [process.execPath, 'check.mjs'], timeoutMs: 20_000 }], evaluation: { profile: 'application_checks' }, policy: { maximumRisk: 'medium', allowUnisolatedRuntime: true } }))
git('add', '-A')
git('commit', '--quiet', '-m', 'initial')

// Plants a hook for every commit-time event and an fsmonitor command in the repository's Git directory, repoints the
// worktree's `.git` file at a directory of its own, and records which of those writes the sandbox let through.
writeFileSync(agentScript, `import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const common = resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim())
const goal = JSON.parse(readFileSync(process.env.APERTURE_RUN_REQUEST, 'utf8')).intent.goal
const own = resolve(execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim())
const attempts = {}
const attempt = (name, write) => { try { write(); attempts[name] = 'written' } catch (error) { attempts[name] = error.code ?? 'failed' } }
attempt('status', () => execFileSync('git', ['status', '--porcelain'], { stdio: 'ignore' }))
for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout', 'reference-transaction']) attempt('hook:' + hook, () => { mkdirSync(join(common, 'hooks'), { recursive: true }); writeFileSync(join(common, 'hooks', hook), readFileSync(${JSON.stringify(planted.hook)})); chmodSync(join(common, 'hooks', hook), 0o755) })
attempt('config', () => writeFileSync(join(common, 'config'), readFileSync(join(common, 'config'), 'utf8') + '[core]\\n\\tfsmonitor = ${planted.fsmonitor}\\n'))
if (goal.includes('commondir') || goal.includes('sandboxed')) attempt('commondir', () => writeFileSync(join(own, 'commondir'), '/nonexistent\\n'))
attempt('dotgit', () => writeFileSync('.git', 'gitdir: /nonexistent\\n'))
writeFileSync('feature.txt', 'changed by the builder\\n')
writeFileSync('attempts.json', JSON.stringify(attempts))
console.log(JSON.stringify({ type: 'message', summary: 'planted' }))
`)

const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
const builder = database.createActor({ username: 'builder', displayName: 'Builder', role: 'developer', password: 'builder-password-2026' }, owner.id)
const approver = database.createActor({ username: 'approver', displayName: 'Approver', role: 'reviewer', password: 'approver-password-2026' }, owner.id)
useProjectRepository(database, repositoryPath, owner.id)
const postprocessor = new LocalRunPostprocessor({ database, evidenceStore: new LocalEvidenceStore(join(dataDirectory, 'evidence')) })
const runnerFor = (confined: boolean) => new LocalCommandAgentRunner({ database, executable: process.execPath, args: [agentScript], worktreeRoot: join(root, 'runs'), timeoutMs: 60_000, postprocessor, ...(confined ? { confinement: { kind: 'seatbelt' as const, denied: [dataDirectory] } } : {}) })

function start(label: string, confined: boolean) {
  const workItem = database.createWorkItem({ title: label, description: label, productType: 'application', ownerActorId: builder.id }, builder.id)
  const intent = database.createIntentVersion({ workItemId: workItem.id, goal: label, constraints: ['none'], riskLevel: 'medium', acceptanceCriteria: [{ statement: 'feature.txt 被修改', criticality: 'critical', verificationType: 'deterministic' }] }, builder.id)
  database.approveIntentVersion(intent.id, approver.id, '可以开工。')
  return runnerFor(confined).run({ workItemId: workItem.id, intentVersionId: intent.id, baseRef: 'main', declaredContextPaths: ['README.md'] }, builder.id)
}

function run(label: string, confined: boolean) {
  const result = start(label, confined)
  assert.equal(result.status, 'succeeded', `${label}: ${result.errorMessage ?? result.status}`)
  const proposal = database.getChangeProposal(result.changeProposalId!)
  assert.equal(git('show', `${proposal.headSha}:feature.txt`), 'changed by the builder', `${label}: the change is committed through the registered Git directory`)
  assert.deepEqual(readdirMarkers(), [], `${label}: no planted command ran`)
  return JSON.parse(git('show', `${proposal.headSha}:attempts.json`)) as Record<string, string>
}

const readdirMarkers = () => ['builder-hook', 'builder-fsmonitor', 'check-fsmonitor'].filter((name) => existsSync(join(markers, name)))

function cleanCommonDirectory() {
  const common = join(repositoryPath, '.git')
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout', 'reference-transaction']) rmSync(join(common, 'hooks', hook), { force: true })
  writeFileSync(join(common, 'config'), readFileSync(join(common, 'config'), 'utf8').replace(/\[core\]\n\tfsmonitor = .*\n/gu, '').replace(/\n\tfsmonitor = .*/gu, ''))
}

try {
  // Unconfined, every write lands, and none of it runs: hooks and fsmonitor are off in every Control Plane Git
  // command, and the worktree's Git directory is the one the repository registered, not what `.git` now says.
  const unconfined = run('unconfined builder plants hooks', false)
  assert.equal(unconfined.config, 'written')
  assert.equal(unconfined['hook:post-commit'], 'written')
  assert.equal(unconfined.dotgit, 'written')
  assert.match(git('config', '--file', join(repositoryPath, '.git/config'), '--get-all', 'core.fsmonitor'), /fsmonitor\.sh$/u, 'the planted fsmonitor command is in place')
  cleanCommonDirectory()

  // An unconfined Builder that repoints the worktree's `commondir`, which Git follows for refs whatever the Control
  // Plane passes it, fails the run before any Git command of the Control Plane touches the worktree.
  assert.throws(() => start('unconfined builder rewrites commondir', false), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'worktree_git_tampered')
  assert.deepEqual(readdirMarkers(), [], 'a refused run ran no planted command either')
  cleanCommonDirectory()

  if (seatbeltAvailable()) {
    // Confined, the repository's Git directory is readable (git status works) and nothing in it is writable, its
    // own `worktrees/<id>` included: a rewritten `commondir` would repoint the config Git reads.
    const confined = run('sandboxed builder plants hooks', true)
    assert.equal(confined.status, 'written', 'read-only Git still works inside the sandbox')
    for (const name of ['hook:pre-commit', 'hook:post-commit', 'config', 'commondir']) assert.equal(confined[name], 'EPERM', `${name} is not writable from the sandbox`)
    assert.equal(confined.dotgit, 'written', 'the worktree itself stays writable')
    assert.equal(existsSync(join(repositoryPath, '.git/hooks/post-commit')), false)
    cleanCommonDirectory()
  } else console.log('git escalation smoke: Seatbelt part skipped, needs macOS sandbox-exec')

  console.log('git escalation smoke passed · planted hooks, fsmonitor and .git never ran in the Control Plane')
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
