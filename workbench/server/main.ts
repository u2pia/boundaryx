import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentRunQueue } from './agent-run-queue.ts'
import { createConfiguredAgentRunner } from './agent-runner-factory.ts'
import { ControlPlaneDatabase } from './database.ts'
import { CodeHostSyncer } from './code-host/syncer.ts'
import { githubOAuthConfigFromEnv } from './github-oauth.ts'
import { createControlPlaneServer } from './http-server.ts'

const serverDirectory = dirname(fileURLToPath(import.meta.url))
const workbenchDirectory = resolve(serverDirectory, '..')
const dataDirectory = resolve(process.env.CONTROL_PLANE_DATA_DIR ?? joinDefault(workbenchDirectory, '.aperture'))
const databasePath = resolve(process.env.CONTROL_PLANE_DB ?? joinDefault(dataDirectory, 'control-plane.db'))
const port = Number(process.env.CONTROL_PLANE_PORT ?? 8787)

function joinDefault(...parts: string[]) {
  return parts.join('/')
}

mkdirSync(dataDirectory, { recursive: true })
const database = new ControlPlaneDatabase(databasePath, resolve(serverDirectory, 'migrations'))
const configuredAgent = createConfiguredAgentRunner({ database, dataDirectory })
const agentRunQueue = configuredAgent.runner ? new AgentRunQueue({ database, databasePath, dataDirectory, concurrency: Number(process.env.CONTROL_PLANE_RUN_CONCURRENCY ?? 2), runner: configuredAgent.runner }) : undefined
const orphaned = agentRunQueue?.reconcile() ?? []
const githubOAuth = githubOAuthConfigFromEnv(process.env, `http://127.0.0.1:${port}`)
const codeHostSyncer = new CodeHostSyncer({ database, publicUrl: process.env.CONTROL_PLANE_PUBLIC_URL })
const codeHostSyncSeconds = Number(process.env.CONTROL_PLANE_CODE_HOST_SYNC_SECONDS ?? 30)
codeHostSyncer.start(codeHostSyncSeconds)
const server = createControlPlaneServer({ database, staticDirectory: resolve(workbenchDirectory, 'dist'), agentRunner: configuredAgent.runner, agentRunQueue, agentRuntimeDescriptor: configuredAgent.descriptor, evidenceStore: configuredAgent.evidenceStore, githubOAuth, codeHostSyncer })

server.listen(port, '127.0.0.1', () => {
  console.log(`${new Date().toISOString()} Local Control Plane listening on http://127.0.0.1:${port}`)
  console.log(`SQLite: ${databasePath}`)
  console.log(`Agent Runner: ${configuredAgent.runner?.id ?? 'disabled'} · ${configuredAgent.descriptor.status} · ${configuredAgent.descriptor.isolation}`)
  console.log(`Identity: ${database.getIdentityMode()} mode · GitHub sign-in ${githubOAuth ? `configured · callback ${githubOAuth.redirectUri}` : 'not configured'}`)
  const hosted = database.listProjects().filter((project) => project.codeHost === 'github' && project.status === 'active').length
  console.log(`Projects: ${database.listProjects().length} · ${hosted} on GitHub · code host sync ${codeHostSyncSeconds > 0 ? `every ${codeHostSyncSeconds}s` : 'manual only'}`)
  if (agentRunQueue) console.log(`Agent Run queue: ${agentRunQueue.snapshot().concurrency} concurrent worker(s)${orphaned.length ? ` · failed ${orphaned.length} orphaned run(s): ${orphaned.join(', ')}` : ''}`)
})

// Why the process stopped is the first question after a run is lost, so every exit path says so with a time.
function shutdown(signal: string) {
  console.log(`${new Date().toISOString()} received ${signal}; stopping the Control Plane (in-flight runs are failed on the next start)`)
  agentRunQueue?.close()
  codeHostSyncer.close()
  server.close(() => {
    database.close()
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGHUP', () => shutdown('SIGHUP (terminal closed)'))
process.on('uncaughtException', (error) => {
  console.error(`${new Date().toISOString()} Control Plane crashed: ${error.stack ?? error.message}`)
  process.exit(1)
})
