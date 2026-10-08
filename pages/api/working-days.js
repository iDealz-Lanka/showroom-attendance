import { adminDb, adminAuth } from '../../lib/firebaseAdmin'

// Which dates did the business record anything at all?
//
// An employee can only read their own records, so from the browser they cannot
// tell the difference between "the shop was shut" and "I did not come in".
// This route answers that one question and nothing else: a list of dates.
// No names, no times, no other employee's data — just the days work happened.
//
// Without it, My Attendance can only show days the person actually worked,
// and an absence has no row to appear on.

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const authHeader = req.headers.authorization || ''
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!idToken) return res.status(401).json({ error: 'Not signed in.' })
    try { await adminAuth().verifyIdToken(idToken) }
    catch { return res.status(401).json({ error: 'Session expired. Sign in again.' }) }

    const from = String(req.query.from || '')
    const to   = String(req.query.to   || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD.' })
    }

    // Only the date field comes back, so this stays cheap even over a long range.
    const snap = await adminDb().collection('records')
      .where('date', '>=', from)
      .where('date', '<=', to)
      .select('date')
      .get()

    const dates = [...new Set(snap.docs.map(d => d.get('date')).filter(Boolean))].sort()
    return res.status(200).json({ dates })
  } catch (err) {
    console.error('[api/working-days]', err)
    return res.status(500).json({ error: 'Could not load working days.' })
  }
}
