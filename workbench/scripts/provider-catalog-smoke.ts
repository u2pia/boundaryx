import { providerCatalog, summarizeProviderCatalog, validateProviderCatalog } from '../src/provider-catalog.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const errors = validateProviderCatalog()
assert(errors.length === 0, `provider catalog is invalid: ${errors.join('; ')}`)

const summary = summarizeProviderCatalog()
assert(providerCatalog.length >= 10, 'catalog should cover the main control-plane provider families')
assert(summary.prototypes >= 4, 'catalog should expose current prototype contracts')
assert(summary.next >= 2, 'catalog should expose the next implementation wave')
assert(summary.offlineReady >= 8, 'private and offline deployment should remain the default posture')
assert(providerCatalog.some((entry) => entry.id === 'developer-catalog' && entry.inspiration.includes('Backstage')), 'catalog should record the borrowed catalog pattern')
assert(providerCatalog.some((entry) => entry.id === 'durable-workflow' && entry.inspiration.includes('Temporal')), 'catalog should track durable workflow practices')
assert(providerCatalog.some((entry) => entry.id === 'telemetry-export' && entry.contractRef === 'TelemetryExportProvider' && entry.offlineReady), 'catalog should expose the governed OTLP export boundary')
assert(providerCatalog.some((entry) => entry.id === 'autonomy-decision' && entry.inspiration.includes('Anthropic')), 'catalog should track bounded autonomy practices')

console.log(`provider catalog smoke passed · ${providerCatalog.length} providers · ${summary.contracts} contracts`)
