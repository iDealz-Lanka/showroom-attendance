import { initializeApp, getApps, getApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getAnalytics, isSupported, logEvent } from 'firebase/analytics'

const firebaseConfig = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId:     process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
}

// Reuse the existing app on hot reload instead of initialising twice
const app = getApps().length ? getApp() : initializeApp(firebaseConfig)

export const db = getFirestore(app)

// ── Analytics ───────────────────────────────────────────────────────────────
// Only runs in the browser. Next.js renders on the server first, where
// getAnalytics() throws, so everything below is guarded.
let analytics = null

if (typeof window !== 'undefined') {
  isSupported()
    .then(ok => { if (ok) analytics = getAnalytics(app) })
    .catch(() => { /* analytics unavailable — app keeps working */ })
}

// Safe to call anywhere. Silently no-ops if analytics isn't ready.
export function track(eventName, params = {}) {
  try {
    if (analytics) logEvent(analytics, eventName, params)
  } catch { /* never let tracking break a check-in */ }
}

export { analytics }
