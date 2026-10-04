import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'

// Server-side Firebase. This runs ONLY inside API routes, never in the browser.
//
// The Admin SDK bypasses Firestore security rules entirely, which is exactly
// why the service account key must never reach the client. Next.js only bundles
// env vars prefixed with NEXT_PUBLIC_, so these three stay on the server.
//
// Set these in Vercel -> Settings -> Environment Variables:
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY      (paste the whole key including BEGIN/END lines)
//   LOGIN_PEPPER              (any long random string — see lib/pin.js)
//   MIGRATION_SECRET          (any long random string — used once, then deleted)

function app() {
  if (getApps().length) return getApps()[0]

  const projectId   = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  // Vercel stores newlines as the two characters \ and n, so turn them back
  // into real newlines or the key will not parse.
  const privateKey  = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, ' +
      'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in your environment.'
    )
  }

  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
}

export function adminDb()   { return getFirestore(app()) }
export function adminAuth() { return getAuth(app()) }
