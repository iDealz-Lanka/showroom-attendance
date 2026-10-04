import { adminDb } from '../../lib/firebaseAdmin'
import { hashPin } from '../../lib/pin'
import { FieldValue } from 'firebase-admin/firestore'

// ONE-TIME migration. Run it once, check the result, then delete this file
// and remove MIGRATION_SECRET from your environment.
//
// It reads every employee that still has a plaintext `pin`, writes a hashed
// copy into credentials/{empId}, and removes the plaintext field.
//
// Run with ?dry=1 first to see what it would do without changing anything.
//
//   https://your-site.vercel.app/api/migrate-pins?secret=YOUR_SECRET&dry=1
//   https://your-site.vercel.app/api/migrate-pins?secret=YOUR_SECRET

export default async function handler(req, res) {
  const secret = process.env.MIGRATION_SECRET
  if (!secret || secret.length < 16) {
    return res.status(500).json({ error: 'MIGRATION_SECRET is not set, or is too short.' })
  }
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Wrong secret.' })

  const dryRun = req.query.dry === '1'

  try {
    const db = adminDb()
    const snap = await db.collection('employees').get()

    const done = [], skipped = [], failed = []

    for (const doc of snap.docs) {
      const emp = doc.data()
      const empId = String(emp.empId || '').trim().toUpperCase()

      if (!empId)   { skipped.push({ docId: doc.id, why: 'no empId field' }); continue }
      if (!emp.pin) { skipped.push({ empId, why: 'no plaintext pin — already migrated, or never had one' }); continue }

      if (dryRun) { done.push({ empId, name: emp.name, action: 'would hash and move' }); continue }

      try {
        const record = await hashPin(String(emp.pin))
        await db.collection('credentials').doc(empId).set({
          ...record, empId, migratedAt: Date.now(),
        })
        // Only remove the plaintext once the hash is safely written.
        await doc.ref.update({ pin: FieldValue.delete() })
        done.push({ empId, name: emp.name })
      } catch (e) {
        failed.push({ empId, error: String(e?.message || e) })
      }
    }

    return res.status(200).json({
      dryRun,
      migrated: done.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      done, skipped, failed,
      next: dryRun
        ? 'Looks right? Run the same URL again without &dry=1.'
        : 'Check that staff can still log in, then DELETE pages/api/migrate-pins.js and remove MIGRATION_SECRET.',
    })
  } catch (err) {
    console.error('[api/migrate-pins]', err)
    return res.status(500).json({ error: String(err?.message || err) })
  }
}
