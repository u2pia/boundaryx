import assert from 'node:assert/strict'
import { LocalCiEvidenceAdapter } from '../src/adapters/ci-evidence.ts'

const adapter = new LocalCiEvidenceAdapter()

const junit = await adapter.ingest({
  kind: 'junit',
  sourceUri: 'artifact://junit.xml',
  tool: 'vitest',
  content: '<testsuites tests="12" failures="1" errors="1" skipped="2"></testsuites>',
})
assert.equal(junit.status, 'failed')
assert.deepEqual(junit.summary, { tests: 12, passed: 8, failed: 2, failures: 1, errors: 1, skipped: 2 })

const sarif = await adapter.ingest({
  kind: 'sarif',
  sourceUri: 'artifact://security.sarif',
  content: JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'Semgrep' } }, results: [{ level: 'warning' }, { level: 'note' }] }] }),
})
assert.equal(sarif.tool, 'Semgrep')
assert.equal(sarif.status, 'warning')
assert.deepEqual(sarif.summary, { results: 2, errors: 0, warnings: 1, notes: 1 })

const coverage = await adapter.ingest({
  kind: 'coverage',
  sourceUri: 'artifact://lcov.info',
  content: 'SF:src/a.ts\nLF:100\nLH:92\nBRF:40\nBRH:30\nend_of_record',
})
assert.equal(coverage.status, 'passed')
assert.equal(coverage.summary.lineCoverage, 92)
assert.equal(coverage.summary.branchCoverage, 75)

await assert.rejects(() => adapter.ingest({ kind: 'junit', sourceUri: 'artifact://empty.xml', content: '<testsuite tests="0" />' }), /tests must be greater than zero/)
await assert.rejects(() => adapter.ingest({ kind: 'sarif', sourceUri: 'artifact://bad.sarif', content: '{' }), /malformed JSON/)
await assert.rejects(() => adapter.ingest({ kind: 'coverage', sourceUri: 'artifact://empty.info', content: 'TN:' }), /no line totals/)

console.log('CI evidence adapter smoke tests passed')
