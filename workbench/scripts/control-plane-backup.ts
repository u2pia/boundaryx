import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createControlPlaneBackup, restoreControlPlaneBackup, verifyControlPlaneBackup } from '../server/control-plane-backup.ts'

const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server')
const workbenchDirectory = resolve(serverDirectory, '..')
const migrationDirectory = resolve(serverDirectory, 'migrations')
const dataDirectory = resolve(process.env.CONTROL_PLANE_DATA_DIR ?? resolve(workbenchDirectory, '.aperture'))
const databasePath = resolve(process.env.CONTROL_PLANE_DB ?? resolve(dataDirectory, 'control-plane.db'))
const [command, first, second] = process.argv.slice(2)

function defaultDestination() {
  return resolve(workbenchDirectory, '../output/backups', `control-plane-${new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z')}`)
}

try {
  if (command === 'create') {
    const result = createControlPlaneBackup({ databasePath, dataDirectory, migrationDirectory, destinationDirectory: resolve(first ?? defaultDestination()) })
    console.log(JSON.stringify({ operation: 'create', directory: result.directory, valid: result.verification.valid, databaseSchemaVersion: result.manifest.databaseSchemaVersion, eventAggregates: result.verification.eventIntegrity.aggregateCount, evidencePackages: result.verification.evidence.packageCount, holdouts: result.verification.holdouts.registered, eventSeal: result.manifest.eventSeal }, null, 2))
  } else if (command === 'verify') {
    if (!first) throw new Error('Usage: npm run backup:verify -- <backup-directory>')
    const result = verifyControlPlaneBackup({ backupDirectory: resolve(first), migrationDirectory })
    console.log(JSON.stringify({ operation: 'verify', backupDirectory: resolve(first), ...result }, null, 2))
    if (!result.valid) process.exitCode = 1
  } else if (command === 'restore') {
    if (!first || !second) throw new Error('Usage: npm run backup:restore -- <backup-directory> <new-data-directory>')
    const result = restoreControlPlaneBackup({ backupDirectory: resolve(first), migrationDirectory, destinationDataDirectory: resolve(second) })
    console.log(JSON.stringify({ operation: 'restore', directory: result.directory, valid: result.verification.valid, eventSeal: result.verification.eventSeal }, null, 2))
  } else {
    throw new Error('Usage: control-plane-backup.ts create [destination] | verify <backup-directory> | restore <backup-directory> <new-data-directory>')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
