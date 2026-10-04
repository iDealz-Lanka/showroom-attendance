// WebAuthn configuration. Server-side only.
//
// The Relying Party ID is the domain the credential is bound to. A credential
// created for showroom-attendance.vercel.app only works on that domain — which
// is most of what makes this phishing-resistant, and also why the value has to
// be exactly right.
//
// Derived from the incoming request by default, so preview deployments work
// without configuration. Set WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN to pin it to
// one domain, which you should do once you have a custom domain.

export function rpFrom(req) {
  const envId     = process.env.WEBAUTHN_RP_ID
  const envOrigin = process.env.WEBAUTHN_ORIGIN
  if (envId && envOrigin) return { rpID: envId, origin: envOrigin }

  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
  // Strip the port: an RP ID is a bare domain, never host:port
  const rpID = host.split(':')[0]
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0]
  return { rpID, origin: `${proto}://${host}` }
}

export const RP_NAME = 'iDealz Attendance'

// Stored credentials keep the public key as base64url text, because Firestore
// has no Uint8Array type and a Buffer would come back as an object.
export const toB64  = u8  => Buffer.from(u8).toString('base64url')
export const fromB64 = str => new Uint8Array(Buffer.from(str, 'base64url'))

// What the browser is told to ask for. 'platform' means the device's own
// Face ID / fingerprint, not a USB key; 'required' means the scan must
// actually verify the person, not merely detect a touch.
export const AUTHENTICATOR_SELECTION = {
  authenticatorAttachment: 'platform',
  userVerification: 'required',
  residentKey: 'preferred',
}
