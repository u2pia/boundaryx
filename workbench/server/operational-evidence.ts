import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { sha256 } from './security.ts'

const RECOVERY_EVIDENCE_PREFIX = 'local://operational-evidence/recovery/'

export function operationalEvidencePath(dataDirectory: string, uri: string) {
  if (!uri.startsWith(RECOVERY_EVIDENCE_PREFIX)) throw new Error(`Unsupported operational evidence URI: ${uri}`)
  const filename = uri.slice(RECOVERY_EVIDENCE_PREFIX.length)
  if (!/^[A-Za-z0-9._-]+\.json$/u.test(filename)) throw new Error(`Invalid operational evidence filename: ${filename}`)
  const root = resolve(dataDirectory, 'operational-evidence', 'recovery')
  const path = resolve(root, filename)
  if (!path.startsWith(`${root}${sep}`)) throw new Error(`Operational evidence URI escapes the managed directory: ${uri}`)
  return path
}

export function readOperationalEvidence(dataDirectory: string, uri: string, expectedDigest: string) {
  const path = operationalEvidencePath(dataDirectory, uri)
  const bytes = readFileSync(path)
  const actualDigest = `sha256:${sha256(bytes)}`
  if (actualDigest !== expectedDigest) throw new Error(`Operational evidence digest mismatch: expected ${expectedDigest}, got ${actualDigest}`)
  return { path, bytes, document: JSON.parse(bytes.toString('utf8')) as Record<string, unknown> }
}
