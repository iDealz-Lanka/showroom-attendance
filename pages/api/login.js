import { adminDb, adminAuth } from '../../lib/firebaseAdmin'
import { verifyPin } from '../../lib/pin'
import { signTicket, newChallenge } from '../../lib/ticket'
import { rpFrom, RP_NAME, AUTHENTICATOR_SELECTION } from '../../lib/webauthn'
import { generateRegistrationOptions, generateAuthenticationOptions } from '@simplewebauthn/server'

// Step one of login: check the PIN.
//
// This no longer hands back a Firebase token. It returns a short-lived ticket
// and a WebAuthn challenge, and the token is only issued by
// /api/webauthn/verify once the Face ID or fingerprint check passes. There is
// no code path that reaches a token on a PIN alone.
//
// The one exception is an account an admin has marked exempt — for a back
// office PC with no biometric hardware. That is a deliberate, recorded
// decision rather than a silent fallback.

const attempts = new Map()
const WINDOW_MS = 10 * 60 * 1000
const MAX_TRIES = 8

function tooManyTries(key) {
  const now = Date.now()
  const rec = attempts.get(key)
  if (!rec || now - rec.first > WINDOW_MS) { attempts.set(key, { first: now, n: 1 }); return false }
  rec.n += 1
  return rec.n > MAX_TRIES
}
function clearTries(key) { attempts.delete(key) }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const empId = String(req.body?.empId || '').trim().toUpperCase()
    const pin   = String(req.body?.pin   || '')
    if (!empId || !pin) return res.status(400).json({ error: 'Employee ID and PIN are required.' })

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'
    if (tooManyTries('id:' + empId) || tooManyTries('ip:' + ip)) {
      return res.status(429).json({ error: 'Too many attempts. Wait 10 minutes and try again.' })
    }

    const db = adminDb()
    const snap = await db.collection('employees').where('empId', '==', empId).limit(1).get()
    // The same message for an unknown ID and a wrong PIN, so this endpoint
    // cannot be used to discover which Employee IDs exist.
    const FAIL = 'Employee ID or PIN is incorrect.'
    if (snap.empty) return res.status(401).json({ error: FAIL })

    const doc = snap.docs[0]
    const emp = { id: doc.id, ...doc.data() }

    const credRef  = db.collection('credentials').doc(empId)
    const credSnap = await credRef.get()
    if (!credSnap.exists) return res.status(409).json({ error: 'No PIN set for this account. Contact your Admin.' })

    const cred = credSnap.data()
    if (!(await verifyPin(pin, cred))) return res.status(401).json({ error: FAIL })

    clearTries('id:' + empId); clearTries('ip:' + ip)

    const profile = {
      id: emp.id, empId, name: emp.name, showroom: emp.showroom || '',
      staffType: emp.staffType || 'showroom', role: emp.role || 'employee',
      color: emp.color || '#6c63ff',
    }

    // Exempt accounts skip the device check entirely.
    if (cred.biometricExempt === true) {
      const token = await mintToken(profile)
      return res.status(200).json({ mode: 'exempt', token, employee: profile })
    }

    const { rpID } = rpFrom(req)
    const devices = Array.isArray(cred.devices) ? cred.devices : []
    const challenge = newChallenge()

    let mode, options
    if (devices.length === 0) {
      // No device registered yet: first login, or an admin has just reset them.
      mode = 'register'
      options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID,
        userName: empId,
        userDisplayName: emp.name || empId,
        challenge,
        attestationType: 'none',
        authenticatorSelection: AUTHENTICATOR_SELECTION,
      })
    } else {
      // Registered devices exist, so one of them must answer. A new phone
      // cannot simply enrol itself — an admin has to reset the old one first.
      mode = 'authenticate'
      options = await generateAuthenticationOptions({
        rpID,
        challenge,
        userVerification: 'required',
        allowCredentials: devices.map(d => ({ id: d.id, transports: d.transports || undefined })),
      })
    }

    const ticket = signTicket({ purpose: mode, empId, challenge: options.challenge })
    return res.status(200).json({ mode, ticket, options })
  } catch (err) {
    console.error('[api/login]', err)
    return res.status(500).json({ error: 'Login is temporarily unavailable. Try again shortly.' })
  }
}

async function mintToken(profile) {
  // Claims are signed by Google; the Firestore rules read them directly and
  // the browser cannot edit them.
  return adminAuth().createCustomToken(`emp_${profile.empId}`, {
    role: profile.role, showroom: profile.showroom,
    empId: profile.empId, docId: profile.id,
  })
}
