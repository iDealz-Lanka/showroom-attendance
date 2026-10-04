// Side-effect import: this is what runs initializeApp(). Without it, a page
// that never touches Firestore (the login page) has no Firebase app at all,
// and getApp() throws "No Firebase App '[DEFAULT]' has been created".
import './firebase'
import { getApp } from 'firebase/app'
import { getAuth, signInWithCustomToken, onAuthStateChanged, signOut } from 'firebase/auth'

// Firebase sign-in for the browser.
//
// The token comes from /api/login, which only issues one after verifying the
// PIN on the server. It carries role, showroom and empId as claims signed by
// Google, so the Firestore rules can trust them. Nothing here can be edited
// into saying 'admin' — the signature would not match.
//
// This replaces the earlier anonymous sign-in. Anonymous proved "some browser";
// this proves "this employee, with this role".

const TOKEN_KEY = 'idealz_fb_token'

// Cached result of ensureAuth(). Declared here because signInWithToken and
// signOutEverywhere both reset it.
let ready = null

export function auth() {
  try { return getAuth(getApp()) }
  catch (err) { console.error('[auth] firebase app not ready:', err?.message || err); return null }
}

// Called by the login page once /api/login has returned a token.
export async function signInWithToken(token) {
  const a = auth()
  if (!a) throw new Error('Firebase is not initialised.')
  const cred = await signInWithCustomToken(a, token)
  // ensureAuth() caches its answer. On the login page that answer was "nobody",
  // and Next.js keeps the module alive across client-side navigation — so
  // without this line the home page would read the stale "nobody", clear the
  // session and bounce straight back to login.
  ready = Promise.resolve(cred.user)
  // Kept so a page refresh can sign back in without asking for the PIN again.
  // It is useless on its own: it only works for this Firebase project, it
  // expires, and it is not a PIN.
  try { sessionStorage.setItem(TOKEN_KEY, token) } catch {}
  return cred.user
}

export async function signOutEverywhere() {
  ready = null
  try { sessionStorage.removeItem(TOKEN_KEY) } catch {}
  const a = auth()
  if (a) { try { await signOut(a) } catch {} }
}

// Waits until Firebase has settled on a user, or confirms there is none.
// Never rejects, and never waits longer than 5 seconds.
export function ensureAuth() {
  if (typeof window === 'undefined') return Promise.resolve(null)
  // Whatever Firebase currently holds is the truth. Checking it before the
  // cache means a sign-in that happened after the cache was filled is seen
  // immediately, rather than on the next full page load.
  const live = auth()?.currentUser
  if (live) { ready = Promise.resolve(live); return ready }
  if (ready) return ready

  ready = new Promise(resolve => {
    const a = auth()
    if (!a) { console.warn('[auth] no firebase app'); resolve(null); return }

    let done = false
    const finish = u => { if (!done) { done = true; resolve(u) } }

    const stop = onAuthStateChanged(a, async user => {
      if (user) { stop(); finish(user); return }

      // No live session. If this tab has a token from an earlier page load,
      // use it — this is what makes a refresh not throw you back to login.
      let saved = null
      try { saved = sessionStorage.getItem(TOKEN_KEY) } catch {}
      if (!saved) { stop(); finish(null); return }

      try {
        const cred = await signInWithCustomToken(a, saved)
        stop(); finish(cred.user)
      } catch {
        // Expired or rejected. Clear it and let the app send them to login.
        try { sessionStorage.removeItem(TOKEN_KEY) } catch {}
        stop(); finish(null)
      }
    })

    setTimeout(() => { if (!done) { console.warn('[auth] sign-in timed out'); stop(); finish(null) } }, 5000)
  })

  return ready
}

// The current Firebase ID token, for calling protected API routes.
export async function idToken() {
  const a = auth()
  if (!a?.currentUser) return null
  try { return await a.currentUser.getIdToken() } catch { return null }
}
