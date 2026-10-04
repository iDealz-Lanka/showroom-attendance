import { scrypt, randomBytes, timingSafeEqual } from 'crypto'

// PIN hashing. Server-side only — this file must never be imported by a page.
//
// A 6-digit PIN has only a million possibilities, so a plain hash would fall to
// a wordlist in seconds. Three things make that impractical here:
//
//   salt    a different random value per PIN, so one cracking run cannot be
//           reused across staff
//   pepper  a secret kept in the environment, not in the database. Someone who
//           steals a database dump still cannot test guesses without it.
//   scrypt  deliberately slow and memory-hungry, so each guess costs real work
//
// N=16384 keeps a single verification around 50-100ms on Vercel — unnoticeable
// to a person signing in, punishing to anyone guessing at scale.

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

function pepper() {
  const p = process.env.LOGIN_PEPPER
  if (!p || p.length < 16) {
    throw new Error('LOGIN_PEPPER is missing or too short. Set a long random string in your environment.')
  }
  return p
}

function derive(pin, salt) {
  return new Promise((resolve, reject) => {
    scrypt(String(pin) + pepper(), salt, SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      (err, key) => err ? reject(err) : resolve(key))
  })
}

export async function hashPin(pin) {
  const salt = randomBytes(16).toString('hex')
  const key  = await derive(pin, salt)
  return { salt, hash: key.toString('hex'), algo: 'scrypt-16384-8-1' }
}

// Compared with timingSafeEqual so the time taken does not leak how much of
// the hash matched.
export async function verifyPin(pin, record) {
  if (!record?.salt || !record?.hash) return false
  try {
    const key      = await derive(pin, record.salt)
    const expected = Buffer.from(record.hash, 'hex')
    if (key.length !== expected.length) return false
    return timingSafeEqual(key, expected)
  } catch {
    return false
  }
}
