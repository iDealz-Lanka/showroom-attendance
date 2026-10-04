import { getApp } from 'firebase/app'
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth'

// Signs the browser in to Firebase anonymously, once per page load.
//
// Why: the Firestore rules require `request.auth != null`. Without this, every
// read and write is rejected. Anonymous sign-in gives the browser a Firebase
// identity without asking anyone for anything — staff never see it happen.
//
// What it does NOT do: it does not identify the employee. Everyone gets an
// anonymous uid. It keeps strangers out of the database; it does not stop a
// member of staff who has signed in to the app from reading it.
//
// This must never be able to white-screen the app. Every failure path still
// resolves, so the app loads with or without a Firebase identity.

let ready = null

export function ensureAuth() {
  // No window during server-side rendering, and nothing to sign in.
  if (typeof window === 'undefined') return Promise.resolve(null)
  // Cached: later calls reuse the first sign-in rather than repeating it.
  if (ready) return ready

  ready = new Promise(resolve => {
    let auth
    try {
      auth = getAuth(getApp())
    } catch (err) {
      // Firebase app not initialised. Nothing to do; let the app render.
      console.warn('[auth] no firebase app:', err?.message || err)
      resolve(null)
      return
    }

    let done = false
    const finish = user => { if (!done) { done = true; resolve(user) } }

    // A session persists in the browser, so a returning visitor is often
    // already signed in and this fires immediately.
    const stop = onAuthStateChanged(auth, user => { if (user) { stop(); finish(user) } })

    signInAnonymously(auth).catch(err => {
      // Almost always: Anonymous sign-in is not enabled in the Firebase
      // console (Authentication -> Sign-in method -> Anonymous -> Enable).
      // Resolve anyway — while the rules are still open the app works fine,
      // and once they are locked down the failure is visible in the console
      // rather than as a blank screen.
      console.warn('[auth] anonymous sign-in failed:', err?.code || err)
      stop(); finish(null)
    })

    // Never hang the app on a slow or blocked network.
    setTimeout(() => { if (!done) { console.warn('[auth] sign-in timed out'); stop(); finish(null) } }, 5000)
  })

  return ready
}
