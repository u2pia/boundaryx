import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const source = readFileSync('src/import-validator.ts', 'utf8')
const runtimeSource = source
  .replace(/export type [\s\S]*?\n\}\n/gu, '')
  .replaceAll(': ImportFile', '')
  .replaceAll(': ImportValidationResult', '')
  .replaceAll(': string[]', '')
mkdirSync('dist', { recursive: true })
writeFileSync('dist/import-validator.js', `// Governed application artifact built from src/import-validator.ts\n${runtimeSource}`)
execFileSync(process.execPath, ['--check', 'dist/import-validator.js'], { stdio: 'inherit' })
console.log('built dist/import-validator.js')
