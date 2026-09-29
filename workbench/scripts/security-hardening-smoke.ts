import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LoginThrottle } from '../server/login-protection.ts'

const throttle = new LoginThrottle({ maxAccountFailures: 2, maxSourceFailures: 3, windowMs: 100, blockMs: 100, maxEntries: 100 })
assert.equal(throttle.recordFailure('account:member', throttle.maxAccountFailures, 1_000), false)
assert.equal(throttle.recordFailure('account:member', throttle.maxAccountFailures, 1_010), true)
assert.equal(throttle.isBlocked('account:member', 1_050), true)
assert.equal(throttle.isBlocked('account:member', 1_111), false)
throttle.recordFailure('source:local', throttle.maxSourceFailures, 2_000)
throttle.clear('source:local')
assert.equal(throttle.isBlocked('source:local', 2_001), false)

const root = mkdtempSync(join(tmpdir(), 'aperture-startup-security-'))
try {
  const main = resolve(dirname(fileURLToPath(import.meta.url)), '../server/main.ts')
  const result = spawnSync(process.execPath, ['--experimental-strip-types', main], {
    encoding: 'utf8',
    env: { ...process.env, CONTROL_PLANE_DATA_DIR: root, CONTROL_PLANE_HOST: '0.0.0.0', CONTROL_PLANE_PORT: '0', CONTROL_PLANE_CODE_HOST_SYNC_SECONDS: '0' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Refusing to expose an uninitialized Control Plane/u)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('security hardening smoke passed')
