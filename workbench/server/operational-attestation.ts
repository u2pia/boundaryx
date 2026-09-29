import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { ControlPlaneDatabase } from './database.ts'
import { ControlPlaneDatabase as RestoredControlPlaneDatabase } from './database.ts'
import { auditCoreIntegrity } from './core-integrity-auditor.ts'
import { restoreControlPlaneBackup, verifyControlPlaneBackup, type ControlPlaneBackupManifest } from './control-plane-backup.ts'
import { sha256 } from './security.ts'
import { AppError } from './types.ts'

export const RECOVERY_DRILL_SCHEMA = 'aperture.recovery-drill.v1'

export function performRecoveryDrill(input: {
  database: ControlPlaneDatabase
  migrationDirectory: string
  backupDirectory: string
  dataDirectory: string
  actorId: string
  validDays?: number
  env?: NodeJS.ProcessEnv
}) {
  const validDays = input.validDays ?? 30
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 45) throw new AppError(400, 'Recovery drill validity must be an integer from 1 to 45 days', 'invalid_recovery_drill_validity')
  const backupDirectory = resolve(input.backupDirectory)
  const migrationDirectory = resolve(input.migrationDirectory)
  const dataDirectory = resolve(input.dataDirectory)
  if (dataDirectory !== resolve(input.database.dataDirectory)) throw new AppError(400, 'Operational evidence must be stored in the database managed data directory', 'invalid_operational_evidence_directory')
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aperture-recovery-drill-'))
  const restoreDirectory = join(temporaryRoot, 'restored')
  const performedAt = new Date().toISOString()
  try {
    const verification = verifyControlPlaneBackup({ backupDirectory, migrationDirectory, env: input.env })
    if (!verification.valid) throw new AppError(409, `Backup verification failed: ${verification.faults.join('; ')}`, 'backup_verification_failed')
    restoreControlPlaneBackup({ backupDirectory, migrationDirectory, destinationDataDirectory: restoreDirectory, env: input.env })
    const restoredDatabase = new RestoredControlPlaneDatabase(join(restoreDirectory, 'control-plane.db'), migrationDirectory)
    let coreIntegrity
    try {
      coreIntegrity = auditCoreIntegrity({ database: restoredDatabase, evidenceDirectory: join(restoreDirectory, 'evidence'), env: input.env })
    } finally {
      restoredDatabase.close()
    }
    if (!coreIntegrity.valid) throw new AppError(409, `Restored Core Integrity failed: ${coreIntegrity.findings.filter((finding) => finding.severity === 'critical').map((finding) => `${finding.code}: ${finding.message}`).join('; ')}`, 'restored_core_integrity_failed')

    const manifestBytes = readFileSync(join(backupDirectory, 'backup.json'))
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as ControlPlaneBackupManifest
    const validUntil = new Date(new Date(performedAt).getTime() + validDays * 24 * 60 * 60 * 1000).toISOString()
    const evidence = {
      schemaVersion: RECOVERY_DRILL_SCHEMA,
      performedAt,
      validUntil,
      backup: { directory: backupDirectory, manifestDigest: `sha256:${sha256(manifestBytes)}`, createdAt: manifest.createdAt, databaseSchemaVersion: manifest.databaseSchemaVersion },
      verification: {
        sqliteQuickCheck: verification.database.quickCheck.length === 1 && verification.database.quickCheck[0] === 'ok',
        eventIntegrityValid: verification.eventIntegrity.invalidAggregates.length === 0,
        evidencePackagesVerified: verification.evidence.verifiedLocalPackages,
        externalEvidencePackages: verification.evidence.externalPackages,
        holdoutsVerified: verification.holdouts.verified,
        eventSealKeyId: verification.eventSeal.keyId,
      },
      restore: {
        targetMode: 'temporary_isolated_directory',
        databaseOpened: true,
        coreIntegrityValid: coreIntegrity.valid,
        criticalFindings: coreIntegrity.summary.critical,
        warningFindings: coreIntegrity.summary.warning,
      },
    }
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    const evidenceDirectory = join(dataDirectory, 'operational-evidence', 'recovery')
    mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 })
    const filename = `recovery-drill-${performedAt.replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}.json`
    const evidencePath = join(evidenceDirectory, filename)
    writeFileSync(evidencePath, bytes, { mode: 0o600, flag: 'wx' })
    chmodSync(evidencePath, 0o600)
    try {
      return input.database.recordOperationalAttestation({ evidenceUri: `local://operational-evidence/recovery/${filename}`, evidenceDigest: `sha256:${sha256(bytes)}`, summary: evidence, performedAt, validUntil }, input.actorId)
    } catch (error) {
      rmSync(evidencePath, { force: true })
      throw error
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}
