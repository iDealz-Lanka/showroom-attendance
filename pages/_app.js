import '../styles/globals.css'
import { useEffect, useState } from 'react'
import { ensureAuth } from '../lib/ensureAuth'

// No auto-seed. The employees collection is populated and managed from the
// Admin tab. Calling /api/seed here is what kept recreating the HR Admin
// account after it was deleted in Firestore.
//
// Anonymous Firebase sign-in happens here, before any page renders, so that
// no page can fire a Firestore query before the browser has an identity to
// query with. ensureAuth never rejects and never hangs past 5 seconds, so a
// failure means the app loads without auth rather than not at all.
export default function App({ Component, pageProps }) {
  const [ready, setReady] = useState(false)

  useEffect(() => { ensureAuth().then(() => setReady(true)) }, [])

  if (!ready) {
    return (
      <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
                    background:'#FAF9F5', fontFamily:'system-ui,-apple-system,sans-serif',
                    color:'#8A8982', fontSize:'0.88rem' }}>
        Starting…
      </div>
    )
  }

  return <Component {...pageProps} />
}
