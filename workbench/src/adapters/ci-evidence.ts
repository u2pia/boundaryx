import type { CiEvidenceAdapter, CiEvidenceInput, CiEvidenceRecord } from './contracts'
import { digestValue } from './event-integrity.ts'

function numericAttribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}=["']([0-9]+(?:\\.[0-9]+)?)["']`, 'i'))
  return match ? Number(match[1]) : 0
}

function parseJunit(content: string, input: CiEvidenceInput): CiEvidenceRecord {
  const suiteTag = content.match(/<testsuites?\b[^>]*>/i)?.[0]
  if (!suiteTag) throw new Error('Invalid JUnit report: missing testsuite root')
  const tests = numericAttribute(suiteTag, 'tests')
  const failures = numericAttribute(suiteTag, 'failures')
  const errors = numericAttribute(suiteTag, 'errors')
  const skipped = numericAttribute(suiteTag, 'skipped')
  if (!tests) throw new Error('Invalid JUnit report: tests must be greater than zero')
  const failed = failures + errors
  return {
    kind: 'junit',
    sourceUri: input.sourceUri,
    tool: input.tool ?? 'junit',
    status: failed ? 'failed' : skipped ? 'warning' : 'passed',
    summary: { tests, passed: Math.max(tests - failed - skipped, 0), failed, failures, errors, skipped },
    digest: digestValue(content),
  }
}

function parseSarif(content: string, input: CiEvidenceInput): CiEvidenceRecord {
  let document: unknown
  try {
    document = JSON.parse(content)
  } catch {
    throw new Error('Invalid SARIF report: malformed JSON')
  }
  if (!document || typeof document !== 'object' || !Array.isArray((document as { runs?: unknown }).runs)) throw new Error('Invalid SARIF report: missing runs')
  const runs = (document as { runs: Array<{ tool?: { driver?: { name?: string } }; results?: Array<{ level?: string }> }> }).runs
  const results = runs.flatMap((run) => run.results ?? [])
  const errors = results.filter((result) => result.level === 'error').length
  const warnings = results.filter((result) => result.level === 'warning').length
  const notes = results.filter((result) => result.level === 'note').length
  return {
    kind: 'sarif',
    sourceUri: input.sourceUri,
    tool: input.tool ?? runs[0]?.tool?.driver?.name ?? 'sarif',
    status: errors ? 'failed' : warnings ? 'warning' : 'passed',
    summary: { results: results.length, errors, warnings, notes },
    digest: digestValue(content),
  }
}

function lcovMetric(content: string, key: string) {
  return content.split(/\r?\n/).reduce((total, line) => line.startsWith(`${key}:`) ? total + Number(line.slice(key.length + 1) || 0) : total, 0)
}

function percentage(hit: number, found: number) {
  return found ? Math.round((hit / found) * 10_000) / 100 : 0
}

function parseCoverage(content: string, input: CiEvidenceInput): CiEvidenceRecord {
  const linesFound = lcovMetric(content, 'LF')
  const linesHit = lcovMetric(content, 'LH')
  const branchesFound = lcovMetric(content, 'BRF')
  const branchesHit = lcovMetric(content, 'BRH')
  if (!linesFound) throw new Error('Invalid LCOV report: no line totals')
  const lineCoverage = percentage(linesHit, linesFound)
  const branchCoverage = percentage(branchesHit, branchesFound)
  return {
    kind: 'coverage',
    sourceUri: input.sourceUri,
    tool: input.tool ?? 'lcov',
    status: lineCoverage < 60 ? 'failed' : lineCoverage < 80 ? 'warning' : 'passed',
    summary: { linesFound, linesHit, lineCoverage, branchesFound, branchesHit, branchCoverage },
    digest: digestValue(content),
  }
}

export class LocalCiEvidenceAdapter implements CiEvidenceAdapter {
  async ingest(input: CiEvidenceInput) {
    if (input.kind === 'junit') return parseJunit(input.content, input)
    if (input.kind === 'sarif') return parseSarif(input.content, input)
    return parseCoverage(input.content, input)
  }
}
