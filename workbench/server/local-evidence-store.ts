import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { sha256 } from './security.ts'
import { AppError } from './types.ts'
import type { CriterionCoverage } from './criteria-coverage.ts'

export type StoredEvidencePackage = {
  schemaVersion: 'aperture.evidence.v1'
  generatedAt: string
  projectManifest?: { path: string; baseSha: string; digest: string; schemaVersion: string; policy: { maximumRisk: 'low' | 'medium' | 'high'; allowUnisolatedRuntime: boolean }; evaluation?: { profile: 'application_checks' | 'agent_dataset'; datasetPath?: string; harnessPaths?: string[]; datasetDigest?: string; thresholds: Array<{ metric: string; operator: 'gte' | 'lte'; threshold: number }> }; artifact?: { profile: 'application_build'; buildCheck: string; outputs: string[] } }
  workItem: { id: string; title: string; productType: 'application' | 'agent_system' }
  intent: { id: string; version: number; goal: string; riskLevel: 'low' | 'medium' | 'high'; contentDigest: string; constraints: string[]; acceptanceCriteria: Array<{ id: string; statement: string; criticality: 'normal' | 'critical'; verificationType: 'deterministic' | 'model' | 'human'; ordinal: number }> }
  git: { repositoryPath: string; baseRef: string; baseSha: string; headRef: string; headSha: string; changedFiles: number; additions: number; deletions: number }
  run: { id: string; adapterId: string; startSha?: string; revisionOfProposalId?: string; isolation: 'unisolated_process' | 'container'; networkEgress: 'denied' | 'allowlist' | 'unrestricted'; productionEligible: boolean; runtimeAttestationDigest?: string; stdoutDigest?: string; stderrDigest?: string }
  checks: Array<{ id: string; name: string; kind?: 'test' | 'evaluation' | 'build' | 'integrity'; conclusion: 'success' | 'failure' | 'neutral' | 'cancelled'; exitCode?: number; durationMs: number; stdoutDigest: string; stderrDigest: string; stdoutExcerpt: string; stderrExcerpt: string; metrics?: Record<string, number>; metricConflicts?: string[]; provenance?: 'all_tests' | 'pre_existing' | 'unverified' | 'isolated' | 'isolated_partial'; thresholdResults?: Array<{ metric: string; operator: 'gte' | 'lte'; threshold: number; actual?: number; passed: boolean }> }>
  criteriaCoverage?: CriterionCoverage[]
  artifacts?: Array<{ path: string; sizeBytes: number; sha256: string; generatedByCheck: string; sourceCommitSha: string; productionEligible: false }>
  provenance: { runEventChainHead: string; proposalEventChainHead: string; generatedBy: string }
  packageDigest: string
}

export class LocalEvidenceStore {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true })
  }

  write(input: Omit<StoredEvidencePackage, 'packageDigest'>) {
    const canonical = JSON.stringify(input)
    const packageDigest = `sha256:${sha256(canonical)}`
    const value: StoredEvidencePackage = { ...input, packageDigest }
    const relativePath = `${input.git.headSha.slice(0, 12)}/${input.run.id}.json`
    const target = resolve(this.root, relativePath)
    this.assertInsideRoot(target)
    mkdirSync(dirname(target), { recursive: true })
    const temporary = `${target}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(temporary, target)
    return { uri: `local://evidence/${relativePath}`, sha256: packageDigest, value }
  }

  read(uri: string, expectedDigest: string) {
    const prefix = 'local://evidence/'
    if (!uri.startsWith(prefix)) throw new AppError(422, 'Unsupported evidence URI', 'unsupported_evidence_uri')
    const target = resolve(this.root, uri.slice(prefix.length))
    this.assertInsideRoot(target)
    const raw = readFileSync(target, 'utf8')
    const value = JSON.parse(raw) as StoredEvidencePackage
    const { packageDigest: _storedDigest, ...canonical } = value
    const actualDigest = `sha256:${sha256(JSON.stringify(canonical))}`
    if (actualDigest !== expectedDigest || value.packageDigest !== expectedDigest) throw new AppError(409, 'Evidence package digest verification failed', 'evidence_digest_mismatch')
    return value
  }

  private assertInsideRoot(target: string) {
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) throw new AppError(400, 'Evidence path escapes the configured store', 'invalid_evidence_path')
  }
}
