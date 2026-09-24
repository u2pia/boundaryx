// Executes a single admitted Agent Run and exits. Launched by AgentRunQueue, one process per run, so
// that the synchronous agent runtime and the declared checks never block the Control Plane's event loop.
// The run must already exist in `queued` state; every other input is reconstructed from the database,
// the persisted execution plan and Git.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConfiguredAgentRunner } from './agent-runner-factory.ts'
import { ControlPlaneDatabase } from './database.ts'

const runId = process.argv[2]
if (!runId) {
  console.error('usage: run-worker.ts <runId>')
  process.exit(2)
}

const serverDirectory = dirname(fileURLToPath(import.meta.url))
const dataDirectory = resolve(process.env.CONTROL_PLANE_DATA_DIR ?? resolve(serverDirectory, '../.aperture'))
const databasePath = resolve(process.env.CONTROL_PLANE_DB ?? resolve(dataDirectory, 'control-plane.db'))
const database = new ControlPlaneDatabase(databasePath, resolve(serverDirectory, 'migrations'))

try {
  const configured = createConfiguredAgentRunner({ database, dataDirectory })
  if (!configured.runner) throw new Error('No Agent Runtime is configured in this worker environment')
  const run = configured.runner.execute(runId)
  process.exitCode = run.status === 'succeeded' ? 0 : 1
} catch (error) {
  // The runner has already recorded the terminal state and the reason in the event log; stderr is for
  // the queue's diagnostics only.
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
} finally {
  database.close()
}
