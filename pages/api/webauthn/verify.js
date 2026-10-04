import { adminDb, adminAuth } from '../../../lib/firebaseAdmin'
import { readTicket } from '../../../lib/ticket'
import { rpFrom, toB64, fromB64 } from '../../../lib/webauthn'
import { verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server'

// Step two of login: check the device, then issue the token.
//
// This is the only place a Firebase token is minted for an account that is not
// exempt. The signature the phone produced is verified here against the stored
// public key — the browser just carries bytes, it is not trusted to report
// success. Clearing browser storage therefore proves nothing: the credential
// lives in Firestore, and only an admin reset removes it.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { ticket, response } = req.body || {}
    if (!ticket || !response) return res.status(400).json({ error: 'Missing ticket or response.' })

    // Expired, tampered with, or not issued by us.
    const payload = readTicket(ticket)
    if (!payload) return res.status(401).json({ error: 'That took too long. Please sign in again.' })

    const { purpose, empId, challenge } = payload
    if (purpose !== 'register' && purpose !== 'authenticate') {
      return res.status(400).json({ error: 'Invalid request.' })
    }

    const db = adminDb()
    const credRef  = db.collection('credentials').doc(empId)
    const credSnap = await credRef.get()
    if (!credSnap.exists) return res.status(409).json({ error: 'Account not set up. Contact your Admin.' })

    const cred    = credSnap.data()
    const devices = Array.isArray(cred.devices) ? cred.devices : []
    const { rpID, origin } = rpFrom(req)

    if (purpose === 'register') {
      // A ticket for registration is only honoured while the account genuinely
      // has no devices. Without this, a replayed ticket could add a device to
      // an account that already has one.
      if (devices.length > 0) {
        return res.status(409).json({ error: 'This account already has a registered device. Ask your Admin to reset it.' })
      }

      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      })
      if (!result.verified || !result.registrationInfo) {
        return res.status(401).json({ error: 'Could not register this device.' })
      }

      const c = result.registrationInfo.credential
      await credRef.update({
        devices: [{
          id: c.id,
          publicKey: toB64(c.publicKey),
          counter: c.counter ?? 0,
          transports: c.transports || [],
          deviceType: result.registrationInfo.credentialDeviceType || '',
          backedUp: !!result.registrationInfo.credentialBackedUp,
          addedAt: Date.now(),
          lastUsedAt: Date.now(),
        }],
      })
    } else {
      const saved = devices.find(d => d.id === response.id)
      if (!saved) return res.status(401).json({ error: 'This device is not registered for that account.' })

      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: saved.id,
          publicKey: fromB64(saved.publicKey),
          counter: saved.counter ?? 0,
          transports: saved.transports || undefined,
        },
      })
      if (!result.verified) return res.status(401).json({ error: 'Face ID / fingerprint did not match.' })

      // The counter only ever goes up on a genuine authenticator. Storing it
      // is what would expose a cloned credential replaying an old signature.
      await credRef.update({
        devices: devices.map(d => d.id === saved.id
          ? { ...d, counter: result.authenticationInfo.newCounter, lastUsedAt: Date.now() }
          : d),
      })
    }

    // Device proven. Now, and only now, read the employee and mint the token.
    const empSnap = await db.collection('employees').where('empId', '==', empId).limit(1).get()
    if (empSnap.empty) return res.status(404).json({ error: 'Employee record not found.' })

    const doc = empSnap.docs[0]
    const emp = doc.data()
    const profile = {
      id: doc.id, empId, name: emp.name, showroom: emp.showroom || '',
      staffType: emp.staffType || 'showroom', role: emp.role || 'employee',
      color: emp.color || '#6c63ff',
    }

    const token = await adminAuth().createCustomToken(`emp_${empId}`, {
      role: profile.role, showroom: profile.showroom, empId, docId: profile.id,
    })

    return res.status(200).json({ token, employee: profile })
  } catch (err) {
    console.error('[api/webauthn/verify]', err)
    return res.status(500).json({ error: 'Could not complete the device check. Try again.' })
  }
}
