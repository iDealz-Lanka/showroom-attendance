import { adminDb, adminAuth } from '../../lib/firebaseAdmin'

// Device management. Admin only.
//
//   reset     clears an employee's registered device, so their next login
//             enrols whatever device they are holding. This is what you use
//             when someone gets a new phone or loses the old one.
//   exempt    skips the device check for this account entirely. For a back
//             office machine with no Face ID or fingerprint reader.
//   unexempt  puts the device check back.
//
// Every call requires a Firebase ID token whose role claim is 'admin'. That
// claim was signed by Google at login and cannot be edited in a browser.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const authHeader = req.headers.authorization || ''
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!idToken) return res.status(401).json({ error: 'Not signed in.' })

    let claims
    try { claims = await adminAuth().verifyIdToken(idToken) }
    catch { return res.status(401).json({ error: 'Session expired. Sign in again.' }) }
    if (claims.role !== 'admin') return res.status(403).json({ error: 'Admins only.' })

    const empId  = String(req.body?.empId || '').trim().toUpperCase()
    const action = String(req.body?.action || '')
    if (!empId) return res.status(400).json({ error: 'Employee ID is required.' })

    const db = adminDb()
    const ref  = db.collection('credentials').doc(empId)
    const snap = await ref.get()
    if (!snap.exists) return res.status(404).json({ error: 'That employee has no PIN set yet.' })

    const by = claims.empId || claims.uid

    if (action === 'reset') {
      await ref.update({ devices: [], devicesResetAt: Date.now(), devicesResetBy: by })
      return res.status(200).json({ ok: true, devices: 0, message: 'Device cleared. Their next login will register the phone they are holding.' })
    }

    if (action === 'exempt' || action === 'unexempt') {
      const exempt = action === 'exempt'
      await ref.update({ biometricExempt: exempt, exemptSetAt: Date.now(), exemptSetBy: by })
      return res.status(200).json({
        ok: true, biometricExempt: exempt,
        message: exempt
          ? 'Face ID is no longer required for this account. PIN alone will sign them in.'
          : 'Face ID is required again for this account.',
      })
    }

    if (action === 'status') {
      const d = snap.data()
      return res.status(200).json({
        ok: true,
        devices: Array.isArray(d.devices) ? d.devices.length : 0,
        biometricExempt: d.biometricExempt === true,
        lastUsedAt: d.devices?.[0]?.lastUsedAt || null,
      })
    }

    return res.status(400).json({ error: 'Unknown action.' })
  } catch (err) {
    console.error('[api/devices]', err)
    return res.status(500).json({ error: 'Could not update devices. Try again.' })
  }
}
