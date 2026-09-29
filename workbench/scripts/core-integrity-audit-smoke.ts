import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditCoreIntegrity } from '../server/core-integrity-auditor.ts'
import { ControlPlaneDatabase } from '../server/database.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-core-integrity-'))
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)

try {
  const owner = database.createActor({ username: 'integrity-owner', displayName: 'Integrity Owner', password: 'integrity-owner-password', role: 'owner' })
  const healthy = auditCoreIntegrity({ database, evidenceDirectory: join(root, 'evidence'), env: { CONTROL_PLANE_HOST: '127.0.0.1' } })
  assert.equal(healthy.valid, true)
  assert.equal(healthy.summary.critical, 0)
  assert.ok(healthy.summary.aggregateCount > 0)
  assert.ok(healthy.summary.checkedBindings > 0)

  database.db.prepare('UPDATE actors SET username = ? WHERE id = ?').run('integrity-owner-tampered', owner.id)
  const tampered = auditCoreIntegrity({ database, evidenceDirectory: join(root, 'evidence'), env: { CONTROL_PLANE_HOST: '127.0.0.1' } })
  assert.equal(tampered.valid, false)
  assert.equal(tampered.findings.some((finding) => finding.code === 'actor_creation_unbound'), true)
  assert.equal(tampered.findings.some((finding) => finding.code === 'event_chain_invalid'), false, 'state/event reconciliation catches state tampering even when the event chain still verifies')

  console.log('core integrity audit smoke passed')
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
