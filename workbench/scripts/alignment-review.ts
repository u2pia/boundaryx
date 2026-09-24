import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const workbenchDirectory = resolve(scriptDirectory, '..')
const controlPlaneDirectory = resolve(workbenchDirectory, '..')
const sourceDirectory = resolve(workbenchDirectory, 'src')
const adapterDirectory = resolve(sourceDirectory, 'adapters')
const mainSource = readFileSync(resolve(sourceDirectory, 'main.tsx'), 'utf8')
const readme = readFileSync(resolve(controlPlaneDirectory, 'README.md'), 'utf8')

function files(directory: string, suffix: string) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(resolve(directory, entry.name), suffix) : entry.name.endsWith(suffix) ? [resolve(directory, entry.name)] : [])
}

function countOccurrences(content: string, pattern: RegExp) {
  return content.match(pattern)?.length ?? 0
}

const sourceFiles = [...files(sourceDirectory, '.ts'), ...files(sourceDirectory, '.tsx')]
const sourceContent = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
const pageDeclaration = mainSource.match(/type Page = (?<pages>[^\n]+)/u)?.groups?.pages ?? ''
const pages = pageDeclaration.split('|').map((value) => value.trim()).filter(Boolean)
const adapterFiles = readdirSync(adapterDirectory).filter((file) => file.endsWith('.ts') && file !== 'contracts.ts')
const smokeTests = readdirSync(resolve(workbenchDirectory, 'scripts')).filter((file) => file.endsWith('-smoke.ts'))

const report = {
  generatedAt: new Date().toISOString(),
  northStar: {
    aiNativeSdlcPositioning: readme.includes('AI Native SDLC'),
    reviewBandwidthMetric: readme.includes('审查人时'),
    nineCapabilityGovernance: existsSync(resolve(controlPlaneDirectory, 'docs/GOAL_ALIGNMENT_GOVERNANCE.md')),
    reviewTemplate: existsSync(resolve(controlPlaneDirectory, 'docs/reviews/ALIGNMENT_REVIEW_TEMPLATE.md')),
  },
  scopeEvidence: {
    defaultPageCount: pages.length,
    adapterFileCount: adapterFiles.length,
    smokeTestCount: smokeTests.length,
    mockReferenceCount: countOccurrences(sourceContent, /\bMock[A-Z]\w*/gu),
    localStorageReferenceCount: countOccurrences(sourceContent, /localStorage/gu),
    providerReferenceCount: countOccurrences(sourceContent, /Provider/gu),
    localServicePresent: existsSync(resolve(workbenchDirectory, 'server/main.ts')),
    sqliteMigrationPresent: existsSync(resolve(workbenchDirectory, 'server/migrations/001_initial.sql')),
  },
  manualReviewRequired: [
    '本周期工作是否直接强化 Intent → Event Log 管理脊椎？',
    '是否产生真实审查时间、决策延迟或缺陷护栏数据？',
    '是否把新的治理或基础设施能力错误放入默认产品？',
    'Identity、Review、Evidence 是否绑定可信 Actor 与确定 Head SHA？',
    'Policy deny 是否在真实执行边界生效？',
  ],
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('# AI Native SDLC Alignment Evidence')
  console.log(`\nGenerated: ${report.generatedAt}`)
  console.log('\n## North Star Anchors')
  Object.entries(report.northStar).forEach(([key, value]) => console.log(`- ${value ? 'PASS' : 'FAIL'} ${key}`))
  console.log('\n## Scope Evidence')
  Object.entries(report.scopeEvidence).forEach(([key, value]) => console.log(`- ${key}: ${value}`))
  console.log('\n## Manual Review Required')
  report.manualReviewRequired.forEach((question, index) => console.log(`${index + 1}. ${question}`))
  console.log('\nUse docs/reviews/ALIGNMENT_REVIEW_TEMPLATE.md to record the decision.')
}
