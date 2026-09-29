import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConfiguredAgentRunner } from '../server/agent-runner-factory.ts'
import { ControlPlaneDatabase } from '../server/database.ts'
import { trustProfileForControlPlane, trustProfileMarkdown } from '../server/trust-profile.ts'

const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server')
const workbenchDirectory = resolve(serverDirectory, '..')
const dataDirectory = resolve(process.env.CONTROL_PLANE_DATA_DIR ?? resolve(workbenchDirectory, '.aperture'))
const databasePath = resolve(process.env.CONTROL_PLANE_DB ?? resolve(dataDirectory, 'control-plane.db'))
const outputDirectory = resolve(process.env.CONTROL_PLANE_AUDIT_OUTPUT_DIR ?? resolve(workbenchDirectory, '../output/audits'))
const secureSetting = process.env.CONTROL_PLANE_SECURE_COOKIES?.trim().toLowerCase()
if (secureSetting && secureSetting !== 'true' && secureSetting !== 'false') throw new Error('CONTROL_PLANE_SECURE_COOKIES must be true or false')
const secureCookies = secureSetting ? secureSetting === 'true' : Boolean(process.env.CONTROL_PLANE_PUBLIC_URL?.startsWith('https://'))
const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z')
const database = new ControlPlaneDatabase(databasePath, resolve(serverDirectory, 'migrations'))

try {
  const configuredAgent = createConfiguredAgentRunner({ database, dataDirectory })
  const profile = trustProfileForControlPlane({ database, evidenceDirectory: configuredAgent.evidenceStore.root, runtime: configuredAgent.descriptor, secureCookies, host: process.env.CONTROL_PLANE_HOST })
  mkdirSync(outputDirectory, { recursive: true })
  const jsonPath = resolve(outputDirectory, `trust-profile-${timestamp}.json`)
  const markdownPath = resolve(outputDirectory, `trust-profile-${timestamp}.md`)
  writeFileSync(jsonPath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(markdownPath, trustProfileMarkdown(profile), { mode: 0o600 })
  console.log(JSON.stringify({ level: profile.level, capabilities: profile.capabilities, blockers: profile.blockers, jsonPath, markdownPath }, null, 2))
} finally {
  database.close()
}
