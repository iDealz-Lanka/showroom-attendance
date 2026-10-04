import { adminDb, adminAuth } from '../../lib/firebaseAdmin'
import { hashPin } from '../../lib/pin'

// Sets or changes an employee's PIN. Admin only.
//
// The Admin panel calls this instead of writing a pin field to the employees
// collection. The PIN arrives, is hashed here, and the plain value is never
// stored anywhere.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    // The caller proves who they are with the Firebase ID token from their
    // own session. A role claim of 'admin' is required, and that claim was
    // signed by Google at login — it cannot be forged in the browser.
    const authHeader = req.headers.authorization || ''
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!idToken) return res.status(401).json({ error: 'Not signed in.' })

    let claims
    try {
      claims = await adminAuth().verifyIdToken(idToken)
    } catch {
      return res.status(401).json({ error: 'Session expired. Sign in again.' })
    }
    if (claims.role !== 'admin') return res.status(403).json({ error: 'Admins only.' })

    const empId = String(req.body?.empId || '').trim().toUpperCase()
    const pin   = String(req.body?.pin   || '')

    if (!empId)                return res.status(400).json({ error: 'Employee ID is required.' })
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 to 8 digits.' })

    const db = adminDb()
    const snap = await db.collection('employees').where('empId', '==', empId).limit(1).get()
    if (snap.empty) return res.status(404).json({ error: 'No employee with that ID.' })

    const record = await hashPin(pin)
    await db.collection('credentials').doc(empId).set({
      ...record,
      empId,
      updatedAt: Date.now(),
      updatedBy: claims.empId || claims.uid,
    })

    // Belt and braces: if a plaintext pin is still on the employee document,
    // remove it now.
    const { FieldValue } = await import('firebase-admin/firestore')
    await snap.docs[0].ref.update({ pin: FieldValue.delete() })

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[api/set-pin]', err)
    return res.status(500).json({ error: 'Could not set the PIN. Try again.' })
  }
}
