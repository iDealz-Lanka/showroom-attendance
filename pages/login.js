import { useState, useEffect, useRef } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { saveSession, getSession, storageAvailable } from '../lib/auth'
import { signInWithToken } from '../lib/ensureAuth'
import { startRegistration, startAuthentication } from '@simplewebauthn/browser'

// This page no longer reads the employees collection. It cannot: PINs are
// checked on the server by /api/login, which returns a Firebase token only
// after the PIN matches. Nothing secret passes through the browser.

// The device check is now decided by the server.
//
// /api/login says which ceremony to run and hands over a signed ticket; the
// browser performs the ceremony and posts the result to /api/webauthn/verify,
// which checks the signature against the public key stored in Firestore and
// only then issues the Firebase token.
//
// Nothing here can grant access. If this code lied and claimed success, no
// token would appear, because the token comes from the server's own check.
async function runDeviceCeremony(mode, ticket, options) {
  const response = mode === 'register'
    ? await startRegistration({ optionsJSON: options })
    : await startAuthentication({ optionsJSON: options })

  const r = await fetch('/api/webauthn/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket, response }),
  })
  const data = await r.json().catch(()=>({}))
  if (!r.ok) throw new Error(data?.error || 'Device check failed.')
  return data
}

// Turns the browser's WebAuthn errors into something a shop assistant can act on
function deviceErrorText(err, mode) {
  const n = err?.name || ''
  if (n === 'NotAllowedError')  return mode === 'register'
    ? 'Face ID setup was cancelled. It is required to sign in.'
    : 'Face ID / fingerprint was cancelled or did not match.'
  if (n === 'InvalidStateError') return 'This device is already registered to another account on this phone.'
  if (n === 'NotSupportedError' || n === 'AbortError')
    return 'This device has no Face ID or fingerprint. Ask your Admin to allow PIN-only sign in for you.'
  return err?.message || 'Device check failed. Try again.'
}

export default function Login() {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [step, setStep]       = useState('id')
  const [empId, setEmpId]     = useState('')
  const [pin, setPin]         = useState(['','','','','',''])
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)
  const [shake, setShake]     = useState(false)
  const [bioStatus, setBio]   = useState('')
  const idRef   = useRef()
  const pinRefs = [useRef(),useRef(),useRef(),useRef(),useRef(),useRef()]

  useEffect(()=>{ setMounted(true); if(getSession()) router.replace('/') },[])
  useEffect(()=>{
    if(step==='id')  setTimeout(()=>idRef.current?.focus(),100)
    if(step==='pin') setTimeout(()=>pinRefs[0].current?.focus(),100)
  },[step])

  // No lookup here. Confirming an ID exists before the PIN is asked would let
  // anyone test Employee IDs one by one.
  function handleIdSubmit(e) {
    e?.preventDefault()
    const id = empId.trim().toUpperCase()
    if(!id) return setError('Please enter your Employee ID')
    setEmpId(id); setError(''); setStep('pin')
  }

  function handlePinDigit(val,i) {
    if(!/^\d*$/.test(val)) return
    const p=[...pin]; p[i]=val.slice(-1); setPin(p); setError('')
    if(val&&i<5) pinRefs[i+1].current?.focus()
    if(val&&i===5) submit([...p.slice(0,5),val.slice(-1)].join(''))
  }
  function handlePinKey(e,i) {
    if(e.key==='Backspace'&&!pin[i]&&i>0) pinRefs[i-1].current?.focus()
    if(e.key==='Enter') submit(pin.join(''))
  }

  function wrongPin(msg) {
    setShake(true); setPin(['','','','','','']); setError(msg)
    setTimeout(()=>{ setShake(false); setStep('pin'); setBio(''); pinRefs[0].current?.focus() },600)
  }

  async function submit(entered) {
    const full = entered || pin.join('')
    if (full.length < 4 || loading) return
    setLoading(true); setError('')

    // Step one: the PIN, checked on the server.
    let data
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empId, pin: full }),
      })
      data = await r.json()
      if (!r.ok) { setLoading(false); return wrongPin(data?.error || 'Could not sign in.') }
    } catch {
      setLoading(false)
      return wrongPin('Connection error. Check your internet.')
    }
    setLoading(false)

    // An account the admin has exempted gets its token straight away.
    if (data.mode === 'exempt') { setStep('bio'); setBio('success'); return finish(data) }

    // Step two: the device must prove itself before any token exists.
    setStep('bio'); setBio(data.mode === 'register' ? 'enrolling' : 'scanning')

    let verified
    try {
      verified = await runDeviceCeremony(data.mode, data.ticket, data.options)
    } catch (err) {
      setBio('fail')
      const msg = err?.name ? deviceErrorText(err, data.mode) : (err?.message || 'Device check failed.')
      setTimeout(()=>wrongPin(msg), 900)
      return
    }

    setBio('success')
    return finish(verified)
  }

  async function finish(data) {
    // Checked before signing in, because Private Browsing is the usual cause
    // and the message should say so rather than blaming the network.
    if (!storageAvailable()) {
      setBio('fail')
      setTimeout(()=>wrongPin('Private Browsing stops this site saving your session. Open it in a normal tab and sign in again.'), 900)
      return
    }

    try {
      // Firebase first — the next page starts reading data immediately.
      await signInWithToken(data.token)
    } catch (err) {
      setBio('fail')
      const code = err?.code || err?.message || 'unknown'
      console.error('[login] firebase sign-in failed:', code, err)
      setTimeout(()=>wrongPin(`Firebase refused the session (${code}). Show this to your admin.`), 900)
      return
    }

    saveSession(data.employee)       // cannot throw
    setTimeout(()=>router.replace('/'), 500)
  }

  const filled = pin.filter(p=>p!=='').length
  if(!mounted) return null

  return (<>
    <Head>
      <title>iDealz Attendance</title>
      <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
      <meta name="theme-color" content="#1a6fe8"/>
      <meta name="apple-mobile-web-app-capable" content="yes"/>
    </Head>

    <div style={{ minHeight:'100vh', display:'flex', fontFamily:"'Inter',sans-serif", position:'relative', overflow:'hidden' }}>

      {/* Left panel — brand side (hidden on mobile) */}
      <div style={{ flex:'0 0 45%', background:'#1a6fe8', position:'relative', overflow:'hidden', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:48 }} className="brand-panel">
        <div style={{ position:'absolute', inset:0, background:'linear-gradient(135deg,#1456b8,#1a6fe8)', backgroundSize:'cover', backgroundPosition:'center', opacity:0.18 }}/>
        <div style={{ position:'absolute', inset:0, background:'linear-gradient(135deg, #1456b8 0%, #1a6fe8 50%, #2d7ff9 100%)', opacity:0.92 }}/>
        <div style={{ position:'absolute', inset:0, backgroundImage:'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.08) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(255,255,255,0.05) 0%, transparent 50%)' }}/>

        <div style={{ position:'relative', zIndex:1, textAlign:'center', maxWidth:360 }}>
          <h1 style={{ color:'#fff', fontSize:'2rem', fontWeight:800, marginBottom:12, lineHeight:1.2 }}>Attendance System</h1>
          <p style={{ color:'rgba(255,255,255,0.75)', fontSize:'1rem', lineHeight:1.6, marginBottom:40 }}>
            Secure attendance tracking for all branches
          </p>

          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {[
              { name:'iDealz Prime',  icon:'🏪', loc:'Galle Rd, Colombo 4' },
              { name:'iSeven Mobile',  icon:'📱', loc:'R.A. De Mel Mawatha, Colombo 3' },
              { name:'iDealz Marino',  icon:'🏛️', loc:'Marino Mall, Colombo 3' },
            ].map(s=>(
              <div key={s.name} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', background:'rgba(255,255,255,0.12)', borderRadius:12, backdropFilter:'blur(8px)', border:'1px solid rgba(255,255,255,0.2)', textAlign:'left' }}>
                <div style={{ width:40, height:40, borderRadius:8, flexShrink:0, background:'rgba(255,255,255,0.15)', border:'1px solid rgba(255,255,255,0.25)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'1.3rem' }}>
                  {s.icon}
                </div>
                <div>
                  <div style={{ color:'#fff', fontSize:'0.82rem', fontWeight:600 }}>{s.name}</div>
                  <div style={{ color:'rgba(255,255,255,0.65)', fontSize:'0.72rem' }}>{s.loc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right panel — login form */}
      <div style={{ flex:1, background:'#f7f9fc', display:'flex', alignItems:'center', justifyContent:'center', padding:32, minHeight:'100vh' }}>
        <div style={{ width:'100%', maxWidth:400 }}>

          {/* Step 1: Employee ID */}
          {step==='id'&&(<>
            <div style={{ marginBottom:28 }}>
              <h2 style={{ fontSize:'1.75rem', fontWeight:800, color:'#0f172a', marginBottom:6 }}>Welcome back 👋</h2>
              <p style={{ color:'#64748b', fontSize:'0.9rem' }}>Enter your Employee ID to sign in</p>
            </div>
            <form onSubmit={handleIdSubmit}>
              <div style={{ marginBottom:16 }}>
                <label style={{ display:'block', fontSize:'0.8rem', fontWeight:600, color:'#374151', marginBottom:6 }}>Employee ID</label>
                <input
                  ref={idRef}
                  value={empId}
                  onChange={e=>{ setEmpId(e.target.value.toUpperCase()); setError('') }}
                  placeholder="e.g. EMP-001"
                  style={{ ...inputStyle, letterSpacing:'0.05em' }}
                  autoCapitalize="characters"
                  autoComplete="off"
                />
              </div>
              {error&&<div style={errorStyle}>{error}</div>}
              <button type="submit" style={btnPrimary}>Continue →</button>
            </form>
          </>)}

          {/* Step 2: PIN */}
          {step==='pin'&&(<>
            <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px', background:'#fff', borderRadius:14, border:'1.5px solid #e2e8f0', marginBottom:24, boxShadow:'0 1px 4px rgba(0,0,0,0.06)' }}>
              <div style={{ width:44, height:44, borderRadius:'50%', background:'#e8f1fd', color:'#1a6fe8', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:'1.2rem', flexShrink:0 }}>🪪</div>
              <div>
                <div style={{ fontSize:'0.95rem', fontWeight:600, color:'#0f172a' }}>{empId}</div>
                <div style={{ fontSize:'0.75rem', color:'#64748b' }}>Enter your PIN to continue</div>
              </div>
            </div>

            <div style={{ marginBottom:24 }}>
              <h2 style={{ fontSize:'1.5rem', fontWeight:800, color:'#0f172a', marginBottom:6 }}>Enter your PIN</h2>
              <p style={{ color:'#64748b', fontSize:'0.85rem' }}>6-digit secret PIN</p>
            </div>

            <div style={{ display:'flex', gap:8, justifyContent:'center', marginBottom:20, animation:shake?'shake .4s ease':'none' }}>
              {pin.map((p,i)=>(
                <input
                  key={i}
                  ref={pinRefs[i]}
                  type="password"
                  inputMode="numeric"
                  maxLength={1}
                  value={p}
                  onChange={e=>handlePinDigit(e.target.value,i)}
                  onKeyDown={e=>handlePinKey(e,i)}
                  style={{ width:48, height:58, borderRadius:12, border:`2px solid ${p?'#1a6fe8':'#e2e8f0'}`, textAlign:'center', fontSize:'1.6rem', color:'#0f172a', fontFamily:"'Inter',sans-serif", outline:'none', transition:'all .15s', background:p?'#e8f1fd':'#fff', boxShadow:p?'0 0 0 3px rgba(26,111,232,0.12)':'none' }}
                />
              ))}
            </div>

            {error&&<div style={errorStyle}>{error}</div>}
            <button style={{ ...btnPrimary, opacity:filled>=4&&!loading?1:0.5 }} onClick={()=>submit()} disabled={filled<4||loading}>
              {loading?'Verifying…':'🔐 Verify PIN'}
            </button>
            <button style={btnGhost} onClick={()=>{ setStep('id'); setPin(['','','','','','']); setError('') }}>
              ← Different account
            </button>
          </>)}

          {/* Step 3: Device check */}
          {step==='bio'&&(
            <div style={{ textAlign:'center', padding:'20px 0' }}>
              <div style={{ width:100, height:100, borderRadius:'50%', border:`3px solid ${bioStatus==='success'?'#16a34a':bioStatus==='fail'?'#dc2626':'#1a6fe8'}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'2.8rem', margin:'0 auto 20px', background: bioStatus==='success'?'#dcfce7':bioStatus==='fail'?'#fee2e2':'#e8f1fd', transition:'all .3s' }}>
                {bioStatus==='success'?'✅':bioStatus==='fail'?'❌':bioStatus==='enrolling'?'🔐':'👤'}
              </div>
              <h2 style={{ fontSize:'1.4rem', fontWeight:700, color:'#0f172a', marginBottom:8 }}>
                {bioStatus==='enrolling'?'Set up Face ID':bioStatus==='scanning'?'Confirm it is you':bioStatus==='success'?'Verified!':'Not matched'}
              </h2>
              <p style={{ color:'#64748b', fontSize:'0.85rem' }}>
                {bioStatus==='enrolling'?'This is your first sign in on this device. Register your Face ID or fingerprint.'
                 :bioStatus==='scanning'?'Face ID or fingerprint — required to sign in'
                 :bioStatus==='success'?'Signing you in…':'Going back to PIN…'}
              </p>
            </div>
          )}

          <div style={{ textAlign:'center', marginTop:32, fontSize:'0.72rem', color:'#94a3b8' }}>
            PIN and Face ID both verified on our server
          </div>
        </div>
      </div>
    </div>

    <style>{`
      @media(max-width:768px) {
        .brand-panel { display:none !important; }
      }
      @keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}
      @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
    `}</style>
  </>)
}

const inputStyle = { width:'100%', padding:'13px 16px', background:'#fff', border:'1.5px solid #e2e8f0', borderRadius:12, color:'#0f172a', fontFamily:"'Inter',sans-serif", fontSize:16, outline:'none', transition:'border-color .2s, box-shadow .2s' }
const btnPrimary = { width:'100%', padding:15, background:'#1a6fe8', color:'#fff', border:'none', borderRadius:12, fontFamily:"'Inter',sans-serif", fontWeight:700, fontSize:'1rem', cursor:'pointer', transition:'all .2s', marginBottom:10 }
const btnGhost   = { width:'100%', padding:'10px', background:'transparent', color:'#64748b', border:'none', fontFamily:"'Inter',sans-serif", fontSize:'0.82rem', cursor:'pointer', textAlign:'center', display:'block' }
const errorStyle = { background:'#fee2e2', border:'1px solid #fca5a5', borderRadius:8, padding:'9px 14px', fontSize:'0.8rem', color:'#dc2626', marginBottom:14, textAlign:'center' }
