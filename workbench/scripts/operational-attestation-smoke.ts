import assert from 'node:assert/strict'
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createControlPlaneBackup, verifyControlPlaneBackup } from '../server/control-plane-backup.ts'
import { auditCoreIntegrity } from '../server/core-integrity-auditor.ts'
import { ControlPlaneDatabase } from '../server/database.ts'
import { performRecoveryDrill } from '../server/operational-attestation.ts'
import { operationalEvidencePath } from '../server/operational-evidence.ts'
import { requestContext } from '../server/request-context.ts'
import { trustProfileForControlPlane } from '../server/trust-profile.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-operational-attestation-'))
const dataDirectory = join(root, 'live')
const databasePath = join(dataDirectory, 'control-plane.db')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
const firstBackupDirectory = join(root, 'backup-before-drill')
const secondBackupDirectory = join(root, 'backup-with-drill')
mkdirSync(dataDirectory, { recursive: true })
const database = new ControlPlaneDatabase(databasePath, migrationDirectory)

try {
  const owner = database.createActor({ username: 'recovery-owner', displayName: 'Recovery Owner', password: 'recovery-owner-password', role: 'owner' })
  createControlPlaneBackup({ databasePath, migrationDirectory, destinationDirectory: firstBackupDirectory })

  const attestation = performRecoveryDrill({ database, migrationDirectory, backupDirectory: firstBackupDirectory, dataDirectory, actorId: owner.id, validDays: 30, env: { CONTROL_PLANE_HOST: '127.0.0.1' } })
  assert.equal(attestation.active, true)
  assert.equal(attestation.identity.assurance, 'self_asserted')
  assert.equal(attestation.summary.schemaVersion, 'aperture.recovery-drill.v1')
  const evidencePath = operationalEvidencePath(dataDirectory, attestation.evidenceUri)
  assert.equal(lstatSync(evidencePath).mode & 0o777, 0o600)
  assert.equal(database.listAggregateEvents('operational_attestation', attestation.id).some((event) => event.eventType === 'operational_attestation.recorded'), true)

  const integrity = auditCoreIntegrity({ database, env: { CONTROL_PLANE_HOST: '127.0.0.1' } })
  assert.equal(integrity.valid, true)
  const profile = trustProfileForControlPlane({ database, integrity, secureCookies: false, host: '127.0.0.1' })
  assert.equal(profile.capabilities.verifiedRecovery, false)
  assert.equal(profile.controls.find((control) => control.id === 'recovery_verification')?.evidence.includes('self-asserted'), true)

  createControlPlaneBackup({ databasePath, migrationDirectory, destinationDirectory: secondBackupDirectory })
  assert.equal(verifyControlPlaneBackup({ backupDirectory: secondBackupDirectory, migrationDirectory }).valid, true, 'backups include registered operational evidence')

  database.declareIdentity({ actorId: owner.id, githubLogin: 'recovery-owner' }, owner.id)
  database.completeGithubLogin({ subject: '1001', login: 'recovery-owner' })
  requestContext.run({ authMethod: 'github' }, () => database.setIdentityMode('team', owner.id))
  const externallyAttested = requestContext.run({ authMethod: 'github' }, () => performRecoveryDrill({ database, migrationDirectory, backupDirectory: secondBackupDirectory, dataDirectory, actorId: owner.id, validDays: 30, env: { CONTROL_PLANE_HOST: '127.0.0.1' } }))
  assert.equal(externallyAttested.identity.assurance, 'external')
  const externallyVerifiedProfile = trustProfileForControlPlane({ database, secureCookies: false, host: '127.0.0.1' })
  assert.equal(externallyVerifiedProfile.capabilities.verifiedRecovery, true)

  const revoked = requestContext.run({ authMethod: 'github' }, () => database.revokeOperationalAttestation(attestation.id, 'Scheduled replacement drill', owner.id))
  assert.equal(revoked.active, false)
  assert.equal(database.listAggregateEvents('operational_attestation', attestation.id).some((event) => event.eventType === 'operational_attestation.revoked'), true)
  requestContext.run({ authMethod: 'github' }, () => database.revokeOperationalAttestation(externallyAttested.id, 'Drill lifecycle test complete', owner.id))

  appendFileSync(evidencePath, '{"tampered":true}\n')
  const tampered = auditCoreIntegrity({ database, env: { CONTROL_PLANE_HOST: '127.0.0.1' } })
  assert.equal(tampered.valid, false)
  assert.equal(tampered.findings.some((finding) => finding.code === 'operational_evidence_invalid' && finding.aggregateId === attestation.id), true)

  console.log('operational attestation smoke passed · verify → isolated restore → audit → attest → revoke → tamper detection')
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
