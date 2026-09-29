import { randomUUID } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ControlPlaneDatabase } from './database.ts'
import { auditCoreIntegrity } from './core-integrity-auditor.ts'
import { COLOCATED_SEAL_KEY_FILE, loadEventSealKeyring } from './event-seal.ts'
import { LocalEvidenceStore } from './local-evidence-store.ts'
import { sha256 } from './security.ts'

export const CONTROL_PLANE_BACKUP_SCHEMA = 'aperture.control-plane-backup.v1'

type BackupFile = { path: string; sizeBytes: number; sha256: string }

export type ControlPlaneBackupManifest = {
  schemaVersion: typeof CONTROL_PLANE_BACKUP_SCHEMA
  createdAt: string
  databaseFile: 'control-plane.db'
  databaseSchemaVersion: number
  files: BackupFile[]
  eventSeal: { keyId: string; source: 'env' | 'file' | 'colocated'; keyIncluded: boolean; retiredKeysRequired: boolean }
  excludedRuntimePaths: string[]
  verificationAtCreation?: { valid: boolean; aggregateCount: number; evidencePackageCount: number; holdoutCount: number }
}

export type ControlPlaneBackupVerification = {
  valid: boolean
  faults: string[]
  database: { quickCheck: string[]; schemaVersionBefore: number; schemaVersionAfter: number; latestSupportedVersion: number }
  eventIntegrity: { aggregateCount: number; eventCount: number; invalidAggregates: Array<{ aggregateType: string; aggregateId: string; faults: string[] }> }
  evidence: { packageCount: number; verifiedLocalPackages: number; externalPackages: number }
  holdouts: { registered: number; verified: number }
  eventSeal: { keyId: string; keySource: string; unsealed: number; sealedByOtherKeys: number }
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function latestMigrationVersion(migrationDirectory: string) {
  return Math.max(0, ...readdirSync(migrationDirectory).filter((file) => /^\d+_.*\.sql$/u.test(file)).map((file) => Number(file.split('_')[0])))
}

function databaseSchemaVersion(databasePath: string) {
  const database = new DatabaseSync(databasePath)
  try {
    return Number((database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number }).version)
  } finally {
    database.close()
  }
}

function walkFiles(root: string, current = root): string[] {
  if (!existsSync(current)) return []
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Backup content may not contain symbolic links: ${relative(root, path)}`)
    return entry.isDirectory() ? walkFiles(root, path) : [relative(root, path)]
  }).sort()
}

function fileRecord(root: string, relativePath: string): BackupFile {
  const path = resolve(root, relativePath)
  const stat = lstatSync(path)
  if (!stat.isFile()) throw new Error(`Backup path is not a regular file: ${relativePath}`)
  return { path: relativePath.split(sep).join('/'), sizeBytes: stat.size, sha256: `sha256:${sha256(readFileSync(path))}` }
}

function assertRelativePath(path: string) {
  if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.')) throw new Error(`Invalid backup path: ${path}`)
}

function copyManagedData(databaseDataDirectory: string, runtimeDataDirectory: string, destinationDirectory: string, includeColocatedKey: boolean) {
  const evidence = join(runtimeDataDirectory, 'evidence')
  if (existsSync(evidence)) cpSync(evidence, join(destinationDirectory, 'evidence'), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
  const holdouts = join(databaseDataDirectory, 'holdouts')
  if (existsSync(holdouts)) cpSync(holdouts, join(destinationDirectory, 'holdouts'), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
  if (includeColocatedKey) copyFileSync(join(databaseDataDirectory, COLOCATED_SEAL_KEY_FILE), join(destinationDirectory, COLOCATED_SEAL_KEY_FILE))
}

export function createControlPlaneBackup(input: { databasePath: string; dataDirectory?: string; migrationDirectory: string; destinationDirectory: string; env?: NodeJS.ProcessEnv }) {
  const databasePath = resolve(input.databasePath)
  const migrationDirectory = resolve(input.migrationDirectory)
  const destinationDirectory = resolve(input.destinationDirectory)
  if (!existsSync(databasePath)) throw new Error(`Control Plane database does not exist: ${databasePath}`)
  if (existsSync(destinationDirectory)) throw new Error(`Backup destination already exists: ${destinationDirectory}`)
  mkdirSync(dirname(destinationDirectory), { recursive: true })
  const staging = `${destinationDirectory}.partial-${randomUUID()}`
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    const snapshotPath = join(staging, 'control-plane.db')
    const source = new DatabaseSync(databasePath)
    try {
      source.exec('PRAGMA busy_timeout = 5000')
      source.exec(`VACUUM INTO ${sqlString(snapshotPath)}`)
    } finally {
      source.close()
    }

    const databaseDataDirectory = dirname(databasePath)
    const runtimeDataDirectory = resolve(input.dataDirectory ?? databaseDataDirectory)
    const keyring = loadEventSealKeyring(databaseDataDirectory, input.env ?? process.env)
    const keyIncluded = keyring.source === 'colocated'
    copyManagedData(databaseDataDirectory, runtimeDataDirectory, staging, keyIncluded)
    const files = walkFiles(staging).map((path) => fileRecord(staging, path))
    const manifest: ControlPlaneBackupManifest = {
      schemaVersion: CONTROL_PLANE_BACKUP_SCHEMA,
      createdAt: new Date().toISOString(),
      databaseFile: 'control-plane.db',
      databaseSchemaVersion: databaseSchemaVersion(snapshotPath),
      files,
      eventSeal: { keyId: keyring.keyId, source: keyring.source, keyIncluded, retiredKeysRequired: Boolean((input.env ?? process.env).APERTURE_EVENT_SEAL_RETIRED_KEY_FILES) },
      excludedRuntimePaths: ['agent-runs/', 'repositories/', 'demo/'],
    }
    writeFileSync(join(staging, 'backup.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    const verification = verifyControlPlaneBackup({ backupDirectory: staging, migrationDirectory, env: input.env })
    if (!verification.valid) throw new Error(`Created backup did not verify: ${verification.faults.join('; ')}`)
    manifest.verificationAtCreation = { valid: true, aggregateCount: verification.eventIntegrity.aggregateCount, evidencePackageCount: verification.evidence.packageCount, holdoutCount: verification.holdouts.registered }
    writeFileSync(join(staging, 'backup.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    renameSync(staging, destinationDirectory)
    return { directory: destinationDirectory, manifest, verification }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

export function verifyControlPlaneBackup(input: { backupDirectory: string; migrationDirectory: string; env?: NodeJS.ProcessEnv }): ControlPlaneBackupVerification {
  const backupDirectory = resolve(input.backupDirectory)
  const migrationDirectory = resolve(input.migrationDirectory)
  const faults: string[] = []
  const manifest = JSON.parse(readFileSync(join(backupDirectory, 'backup.json'), 'utf8')) as ControlPlaneBackupManifest
  if (manifest.schemaVersion !== CONTROL_PLANE_BACKUP_SCHEMA) faults.push(`unsupported backup schema ${String(manifest.schemaVersion)}`)
  const expected = new Map(manifest.files.map((file) => [file.path, file]))
  for (const file of manifest.files) {
    try {
      assertRelativePath(file.path)
      const actual = fileRecord(backupDirectory, file.path)
      if (actual.sizeBytes !== file.sizeBytes || actual.sha256 !== file.sha256) faults.push(`${file.path} does not match its recorded size and digest`)
    } catch (error) {
      faults.push(error instanceof Error ? error.message : String(error))
    }
  }
  try {
    for (const path of walkFiles(backupDirectory).filter((path) => path !== 'backup.json')) if (!expected.has(path.split(sep).join('/'))) faults.push(`unexpected file ${path}`)
  } catch (error) {
    faults.push(error instanceof Error ? error.message : String(error))
  }

  const latestSupportedVersion = latestMigrationVersion(migrationDirectory)
  let schemaVersionBefore = 0
  let schemaVersionAfter = 0
  let quickCheck: string[] = []
  let aggregateCount = 0
  let eventCount = 0
  const invalidAggregates: Array<{ aggregateType: string; aggregateId: string; faults: string[] }> = []
  let packageCount = 0
  let verifiedLocalPackages = 0
  let externalPackages = 0
  let registeredHoldouts = 0
  let verifiedHoldouts = 0
  let eventSeal = { keyId: '', keySource: 'unavailable', unsealed: 0, sealedByOtherKeys: 0 }
  const temporaryRoot = join(dirname(backupDirectory), `.verify-${basename(backupDirectory)}-${randomUUID()}`)
  try {
    cpSync(backupDirectory, temporaryRoot, { recursive: true, errorOnExist: true, force: false })
    const copiedDatabasePath = join(temporaryRoot, manifest.databaseFile)
    const raw = new DatabaseSync(copiedDatabasePath)
    try {
      quickCheck = (raw.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>).map((row) => row.quick_check)
      schemaVersionBefore = Number((raw.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number }).version)
    } finally {
      raw.close()
    }
    if (quickCheck.length !== 1 || quickCheck[0] !== 'ok') faults.push(`SQLite quick_check failed: ${quickCheck.join(', ')}`)
    if (schemaVersionBefore > latestSupportedVersion) faults.push(`backup schema ${schemaVersionBefore} is newer than supported schema ${latestSupportedVersion}`)

    const database = new ControlPlaneDatabase(copiedDatabasePath, migrationDirectory)
    try {
      schemaVersionAfter = Number((database.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number }).version)
      if (schemaVersionAfter !== latestSupportedVersion) faults.push(`database migrated to ${schemaVersionAfter}, expected ${latestSupportedVersion}`)
      const aggregates = database.db.prepare('SELECT aggregate_type, aggregate_id, COUNT(*) AS event_count FROM domain_events GROUP BY aggregate_type, aggregate_id ORDER BY aggregate_type, aggregate_id').all() as Array<{ aggregate_type: string; aggregate_id: string; event_count: number }>
      aggregateCount = aggregates.length
      eventCount = aggregates.reduce((sum, aggregate) => sum + Number(aggregate.event_count), 0)
      for (const aggregate of aggregates) {
        const integrity = database.getEventIntegrity(aggregate.aggregate_type, aggregate.aggregate_id)
        if (!integrity.valid) invalidAggregates.push({ aggregateType: aggregate.aggregate_type, aggregateId: aggregate.aggregate_id, faults: integrity.faults })
      }
      if (invalidAggregates.length) faults.push(`${invalidAggregates.length} event aggregate(s) failed digest or seal verification`)
      eventSeal = database.getEventSealStatus()

      const evidenceRows = database.db.prepare('SELECT id, uri, sha256 FROM evidence_packages ORDER BY id').all() as Array<{ id: string; uri: string; sha256: string }>
      packageCount = evidenceRows.length
      const evidenceStore = new LocalEvidenceStore(join(temporaryRoot, 'evidence'))
      for (const evidence of evidenceRows) {
        if (!evidence.uri.startsWith('local://evidence/')) { externalPackages += 1; continue }
        try {
          evidenceStore.read(evidence.uri, evidence.sha256)
          verifiedLocalPackages += 1
        } catch (error) {
          faults.push(`evidence ${evidence.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const holdoutEvents = database.db.prepare("SELECT aggregate_id, payload_json FROM domain_events WHERE aggregate_type = 'project' AND event_type = 'project.evaluation_holdout_registered' ORDER BY aggregate_id, aggregate_version").all() as Array<{ aggregate_id: string; payload_json: string }>
      registeredHoldouts = holdoutEvents.length
      for (const event of holdoutEvents) {
        const digest = String((JSON.parse(event.payload_json) as Record<string, unknown>).digest ?? '')
        if (database.readEvaluationHoldout(event.aggregate_id, digest) !== undefined) verifiedHoldouts += 1
        else faults.push(`holdout ${event.aggregate_id}/${digest} is missing or has the wrong digest`)
      }
      const coreAudit = auditCoreIntegrity({ database, evidenceDirectory: join(temporaryRoot, 'evidence'), env: input.env })
      for (const finding of coreAudit.findings.filter((item) => item.severity === 'critical')) faults.push(`core integrity ${finding.code}: ${finding.message}`)
    } finally {
      database.close()
    }
  } catch (error) {
    faults.push(error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }

  return {
    valid: faults.length === 0,
    faults,
    database: { quickCheck, schemaVersionBefore, schemaVersionAfter, latestSupportedVersion },
    eventIntegrity: { aggregateCount, eventCount, invalidAggregates },
    evidence: { packageCount, verifiedLocalPackages, externalPackages },
    holdouts: { registered: registeredHoldouts, verified: verifiedHoldouts },
    eventSeal,
  }
}

export function restoreControlPlaneBackup(input: { backupDirectory: string; migrationDirectory: string; destinationDataDirectory: string; env?: NodeJS.ProcessEnv }) {
  const destination = resolve(input.destinationDataDirectory)
  if (existsSync(destination)) throw new Error(`Restore destination already exists: ${destination}`)
  const verification = verifyControlPlaneBackup(input)
  if (!verification.valid) throw new Error(`Backup verification failed: ${verification.faults.join('; ')}`)
  const backupDirectory = resolve(input.backupDirectory)
  const manifest = JSON.parse(readFileSync(join(backupDirectory, 'backup.json'), 'utf8')) as ControlPlaneBackupManifest
  const staging = `${destination}.partial-${randomUUID()}`
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    for (const file of manifest.files) {
      assertRelativePath(file.path)
      const target = resolve(staging, file.path)
      if (target !== staging && !target.startsWith(`${staging}${sep}`)) throw new Error(`Backup path escapes restore destination: ${file.path}`)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(resolve(backupDirectory, file.path), target)
      const restored = fileRecord(staging, file.path)
      if (restored.sizeBytes !== file.sizeBytes || restored.sha256 !== file.sha256) throw new Error(`Restored file does not verify: ${file.path}`)
    }
    writeFileSync(join(staging, 'restore-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    mkdirSync(dirname(destination), { recursive: true })
    renameSync(staging, destination)
    return { directory: destination, verification }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}
