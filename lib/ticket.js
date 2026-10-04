import { createHmac, timingSafeEqual, randomBytes } from 'crypto'

// Short-lived signed tickets. Server-side only.
//
// The login is two steps — PIN, then Face ID — and the second step has to know
// that the first one passed. Rather than keeping server state between the two
// (which does not survive across serverless instances), the first step hands
// the browser a ticket: a small signed blob saying "this Employee ID cleared
// the PIN, and here is the WebAuthn challenge they must answer."
//
// The browser cannot read or forge it. The signature is HMAC-SHA256 under a
// key derived from LOGIN_PEPPER, so tampering invalidates it, and `exp` keeps
// a stolen ticket useless within a couple of minutes.

const TTL_MS = 2 * 60 * 1000

function key() {
  const p = process.env.LOGIN_PEPPER
  if (!p || p.length < 16) throw new Error('LOGIN_PEPPER is missing or too short.')
  // A separate label so this key is not the same value used for PIN hashing.
  return createHmac('sha256', p).update('webauthn-ticket-v1').digest()
}

const b64u  = buf => Buffer.from(buf).toString('base64url')
const unb64 = str => Buffer.from(str, 'base64url')

export function newChallenge() { return b64u(randomBytes(32)) }

export function signTicket(payload) {
  const body = b64u(JSON.stringify({ ...payload, exp: Date.now() + TTL_MS }))
  const sig  = createHmac('sha256', key()).update(body).digest('base64url')
  return `${body}.${sig}`
}

// Returns the payload, or null for anything wrong: bad shape, bad signature,
// expired, or the wrong purpose.
export function readTicket(token, expectedPurpose) {
  try {
    if (typeof token !== 'string' || !token.includes('.')) return null
    const [body, sig] = token.split('.')
    if (!body || !sig) return null

    const expected = createHmac('sha256', key()).update(body).digest()
    const given    = unb64(sig)
    if (given.length !== expected.length) return null
    if (!timingSafeEqual(given, expected)) return null

    const payload = JSON.parse(unb64(body).toString('utf8'))
    if (!payload?.exp || Date.now() > payload.exp) return null
    if (expectedPurpose && payload.purpose !== expectedPurpose) return null
    return payload
  } catch {
    return null
  }
}
