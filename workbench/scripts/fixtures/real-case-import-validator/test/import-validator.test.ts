import assert from 'node:assert/strict'
import test from 'node:test'
import { validateImportFile } from '../src/import-validator.ts'

test('accepts CSV and JSON imports up to 5 MiB', () => {
  assert.deepEqual(validateImportFile({ name: 'customers.csv', sizeBytes: 5 * 1024 * 1024 }), { valid: true, errors: [] })
  assert.deepEqual(validateImportFile({ name: 'events.JSON', sizeBytes: 512 }), { valid: true, errors: [] })
})

test('rejects unsupported import formats', () => {
  assert.deepEqual(validateImportFile({ name: 'payload.exe', sizeBytes: 128 }), { valid: false, errors: ['unsupported_file_type'] })
})

test('rejects imports larger than 5 MiB', () => {
  assert.deepEqual(validateImportFile({ name: 'customers.csv', sizeBytes: 5 * 1024 * 1024 + 1 }), { valid: false, errors: ['file_too_large'] })
})

test('reports deterministic errors for an invalid empty import', () => {
  assert.deepEqual(validateImportFile({ name: '   ', sizeBytes: -1 }), { valid: false, errors: ['file_name_required', 'invalid_file_size', 'unsupported_file_type'] })
})
