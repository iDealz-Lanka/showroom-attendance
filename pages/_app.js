import '../styles/globals.css'

// No auto-seed. The employees collection is populated and managed from the
// Admin tab. Calling /api/seed here is what kept recreating the HR Admin
// account after it was deleted in Firestore.
export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />
}
