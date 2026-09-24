import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function hashPassword(password: string) {
  if (password.length < 12) throw new Error('Password must contain at least 12 characters')
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

export function verifyPassword(password: string, encoded: string) {
  const [scheme, saltValue, hashValue] = encoded.split('$')
  if (scheme !== 'scrypt' || !saltValue || !hashValue) return false
  const expected = Buffer.from(hashValue, 'base64url')
  const actual = scryptSync(password, Buffer.from(saltValue, 'base64url'), expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url')
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}
