import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createControlPlaneBackup, restoreControlPlaneBackup, verifyControlPlaneBackup } from '../server/control-plane-backup.ts'
import { ControlPlaneDatabase } from '../server/database.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-backup-'))
const dataDirectory = join(root, 'data')
const databasePath = join(dataDirectory, 'control-plane.db')
const backupDirectory = join(root, 'backup')
const restoreDirectory = join(root, 'restored')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')

try {
  mkdirSync(dataDirectory, { recursive: true })
  const database = new ControlPlaneDatabase(databasePath, migrationDirectory)
  const owner = database.createActor({ username: 'backup-owner', displayName: 'Backup Owner', password: 'backup-owner-password', role: 'owner' })
  database.registerEvaluationHoldout('PRJ-DEFAULT', '{"input":"hidden","expected":"verified"}\n', owner.id)
  mkdirSync(join(dataDirectory, 'evidence', 'fixture'), { recursive: true })
  writeFileSync(join(dataDirectory, 'evidence', 'fixture', 'unreferenced.json'), '{"fixture":true}\n')
  database.close()

  const created = createControlPlaneBackup({ databasePath, migrationDirectory, destinationDirectory: backupDirectory })
  assert.equal(created.verification.valid, true)
  assert.equal(created.manifest.eventSeal.keyIncluded, true)
  assert.equal(created.verification.holdouts.registered, 1)
  assert.equal(created.verification.holdouts.verified, 1)

  const verified = verifyControlPlaneBackup({ backupDirectory, migrationDirectory })
  assert.equal(verified.valid, true)
  assert.ok(verified.eventIntegrity.aggregateCount > 0)
  assert.equal(verified.eventIntegrity.invalidAggregates.length, 0)

  const restored = restoreControlPlaneBackup({ backupDirectory, migrationDirectory, destinationDataDirectory: restoreDirectory })
  assert.equal(restored.verification.valid, true)
  const restoredDatabase = new ControlPlaneDatabase(join(restoreDirectory, 'control-plane.db'), migrationDirectory)
  assert.equal(restoredDatabase.listActors().some((actor) => actor.username === 'backup-owner'), true)
  assert.equal(restoredDatabase.readEvaluationHoldout('PRJ-DEFAULT', databaseDigest('{"input":"hidden","expected":"verified"}\n')) !== undefined, true)
  restoredDatabase.close()

  appendFileSync(join(backupDirectory, 'evidence', 'fixture', 'unreferenced.json'), 'tampered\n')
  const tampered = verifyControlPlaneBackup({ backupDirectory, migrationDirectory })
  assert.equal(tampered.valid, false)
  assert.equal(tampered.faults.some((fault) => fault.includes('unreferenced.json')), true)

  console.log('control plane backup smoke passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}

function databaseDigest(content: string) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}
