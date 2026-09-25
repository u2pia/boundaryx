import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sha256 } from './security.ts'

/**
 * Event digests are plain SHA-256, so anyone holding the database file can compute a forged event that chains. Each
 * event is therefore also sealed with an HMAC under a key the database does not contain. The key comes from
 * APERTURE_EVENT_SEAL_KEY or APERTURE_EVENT_SEAL_KEY_FILE; without either, one is generated next to the database,
 * which only helps against someone who copies the database file alone. Retired keys stay verifiable through
 * APERTURE_EVENT_SEAL_RETIRED_KEY_FILES (a path-delimited list), so a key can rotate without breaking old seals.
 */
export type EventSealKeySource = 'env' | 'file' | 'colocated'

export interface EventSealKeyring {
  keyId: string
  source: EventSealKeySource
  /** The file the key was read from, so a confined Builder can be denied it; absent when it came from the environment. */
  keyPath?: string
  seal(eventId: string, eventDigest: string): string
  /** 'valid', or why the seal does not verify under any key this Control Plane holds. */
  verify(keyId: string, eventId: string, eventDigest: string, seal: string): 'valid' | 'mismatch' | 'unknown_key'
}

export const COLOCATED_SEAL_KEY_FILE = 'event-seal.key'

function parseKey(raw: string, origin: string) {
  const text = raw.trim()
  const key = /^[0-9a-f]{64,}$/iu.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'utf8')
  if (key.length < 32) throw new Error(`Event seal key from ${origin} must be at least 32 bytes`)
  return key
}

function keyIdOf(key: Buffer) {
  return `hmac-sha256:${sha256(Buffer.concat([Buffer.from('aperture-event-seal-key-id\n'), key])).slice(0, 16)}`
}

function mac(key: Buffer, eventId: string, eventDigest: string) {
  return createHmac('sha256', key).update(JSON.stringify({ eventId, eventDigest })).digest('hex')
}

function colocatedKey(dataDirectory: string) {
  const path = join(dataDirectory, COLOCATED_SEAL_KEY_FILE)
  try {
    writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return path
}

export function loadEventSealKeyring(dataDirectory: string, env: NodeJS.ProcessEnv = process.env): EventSealKeyring {
  const [key, source]: [Buffer, EventSealKeySource] = env.APERTURE_EVENT_SEAL_KEY
    ? [parseKey(env.APERTURE_EVENT_SEAL_KEY, 'APERTURE_EVENT_SEAL_KEY'), 'env']
    : env.APERTURE_EVENT_SEAL_KEY_FILE
      ? [parseKey(readFileSync(env.APERTURE_EVENT_SEAL_KEY_FILE, 'utf8'), env.APERTURE_EVENT_SEAL_KEY_FILE), 'file']
      : [parseKey(readFileSync(colocatedKey(dataDirectory), 'utf8'), COLOCATED_SEAL_KEY_FILE), 'colocated']
  const keys = new Map([[keyIdOf(key), key]])
  for (const path of (env.APERTURE_EVENT_SEAL_RETIRED_KEY_FILES ?? '').split(':').filter(Boolean)) {
    const retired = parseKey(readFileSync(path, 'utf8'), path)
    keys.set(keyIdOf(retired), retired)
  }
  const keyId = keyIdOf(key)
  return {
    keyId,
    source,
    ...(source === 'env' ? {} : { keyPath: resolve(source === 'file' ? env.APERTURE_EVENT_SEAL_KEY_FILE! : join(dataDirectory, COLOCATED_SEAL_KEY_FILE)) }),
    seal: (eventId, eventDigest) => mac(key, eventId, eventDigest),
    verify(sealKeyId, eventId, eventDigest, seal) {
      const known = keys.get(sealKeyId)
      if (!known) return 'unknown_key'
      const expected = Buffer.from(mac(known, eventId, eventDigest), 'hex')
      const actual = Buffer.from(seal, 'hex')
      return expected.length === actual.length && timingSafeEqual(expected, actual) ? 'valid' : 'mismatch'
    },
  }
}
