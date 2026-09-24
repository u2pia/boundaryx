import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuthMethod } from './types.ts'

/**
 * How the current request's session was proven. The HTTP layer fills it in once the session is resolved; the database
 * reads it when it freezes a decision's identity, so no decision route can forget to pass it along. Calls made outside
 * a request (tests, internal jobs) see no store and are recorded as `internal`.
 */
export type RequestContext = { authMethod?: AuthMethod }

export const requestContext = new AsyncLocalStorage<RequestContext>()
