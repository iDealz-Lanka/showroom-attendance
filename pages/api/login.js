import { adminDb, adminAuth } from '../../lib/firebaseAdmin'
import { verifyPin } from '../../lib/pin'

// Server-side login. The browser sends an Employee ID and a PIN; it never
// receives a PIN back, and never sees the stored hash.
//
// On success the response carries a Firebase custom token whose claims include
// the person's role and branch. The browser signs in with it, and from then on
// Firestore itself enforces what that person can read — not the UI.

// Simple in-memory rate limit. Vercel recycles instances, so this is a speed
// bump against guessing rather than a guarantee; the real defence is that
// scrypt makes each attempt cost ~50ms of server CPU.
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

    // Rate limit per employee ID and per source address
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'
    if (tooManyTries('id:' + empId) || tooManyTries('ip:' + ip)) {
      return res.status(429).json({ error: 'Too many attempts. Wait 10 minutes and try again.' })
    }

    const db = adminDb()

    const snap = await db.collection('employees').where('empId', '==', empId).limit(1).get()
    // Deliberately the same message for an unknown ID and a wrong PIN, so this
    // endpoint cannot be used to find out which Employee IDs exist.
    const FAIL = 'Employee ID or PIN is incorrect.'
    if (snap.empty) return res.status(401).json({ error: FAIL })

    const doc = snap.docs[0]
    const emp = { id: doc.id, ...doc.data() }

    const credSnap = await db.collection('credentials').doc(empId).get()
    if (!credSnap.exists) {
      return res.status(409).json({ error: 'No PIN set for this account. Contact your Admin.' })
    }

    const ok = await verifyPin(pin, credSnap.data())
    if (!ok) return res.status(401).json({ error: FAIL })

    clearTries('id:' + empId); clearTries('ip:' + ip)

    const role     = emp.role || 'employee'
    const showroom = emp.showroom || ''

    // These claims are signed by Google and cannot be edited in the browser.
    // The Firestore rules read them directly.
    const token = await adminAuth().createCustomToken(`emp_${empId}`, {
      role, showroom, empId, docId: emp.id,
    })

    // The profile sent back carries no PIN and no hash.
    return res.status(200).json({
      token,
      employee: {
        id: emp.id, empId, name: emp.name, showroom,
        staffType: emp.staffType || 'showroom', role, color: emp.color || '#6c63ff',
      },
    })
  } catch (err) {
    console.error('[api/login]', err)
    return res.status(500).json({ error: 'Login is temporarily unavailable. Try again shortly.' })
  }
}
