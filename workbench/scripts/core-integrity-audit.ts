import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditCoreIntegrity, coreIntegrityMarkdown } from '../server/core-integrity-auditor.ts'
import { ControlPlaneDatabase } from '../server/database.ts'

const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server')
const workbenchDirectory = resolve(serverDirectory, '..')
const dataDirectory = resolve(process.env.CONTROL_PLANE_DATA_DIR ?? resolve(workbenchDirectory, '.aperture'))
const databasePath = resolve(process.env.CONTROL_PLANE_DB ?? resolve(dataDirectory, 'control-plane.db'))
const outputDirectory = resolve(process.env.CONTROL_PLANE_AUDIT_OUTPUT_DIR ?? resolve(workbenchDirectory, '../output/audits'))
const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z')
const database = new ControlPlaneDatabase(databasePath, resolve(serverDirectory, 'migrations'))

try {
  const report = auditCoreIntegrity({ database, evidenceDirectory: resolve(dataDirectory, 'evidence') })
  mkdirSync(outputDirectory, { recursive: true })
  const jsonPath = resolve(outputDirectory, `core-integrity-${timestamp}.json`)
  const markdownPath = resolve(outputDirectory, `core-integrity-${timestamp}.md`)
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(markdownPath, coreIntegrityMarkdown(report), { mode: 0o600 })
  console.log(JSON.stringify({ valid: report.valid, summary: report.summary, jsonPath, markdownPath }, null, 2))
  if (!report.valid) process.exitCode = 1
} finally {
  database.close()
}
