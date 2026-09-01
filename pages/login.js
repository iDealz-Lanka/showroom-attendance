import { useState, useEffect, useRef } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { db } from '../lib/firebase'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { saveSession, getSession } from '../lib/auth'

async function checkBiometricAvailable() {
  try {
    if (!window.PublicKeyCredential) return false
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch { return false }
}

async function verifyBiometric(empId) {
  const has = await checkBiometricAvailable()
  if (!has) return true
  const challenge = new Uint8Array(32); crypto.getRandomValues(challenge)
  const key = `idealz_cred_${empId}`
  try {
    const existing = localStorage.getItem(key)
    if (existing) {
      const credId = Uint8Array.from(atob(existing), c=>c.charCodeAt(0))
      await navigator.credentials.get({ publicKey:{ challenge, timeout:30000, userVerification:'required', rpId:location.hostname, allowCredentials:[{type:'public-key',id:credId}] } })
    } else {
      const cred = await navigator.credentials.create({ publicKey:{ challenge, rp:{name:'Idealz Attendance',id:location.hostname}, user:{id:new TextEncoder().encode(empId),name:empId,displayName:empId}, pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}], timeout:30000, authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required',residentKey:'preferred'} } })
      localStorage.setItem(key, btoa(String.fromCharCode(...new Uint8Array(cred.rawId))))
    }
    return true
  } catch(e) { if(e.name==='NotAllowedError') return false; return true }
}

export default function Login() {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [step, setStep]       = useState('id')
  const [empId, setEmpId]     = useState('')
  const [employee, setEmp]    = useState(null)
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

  async function handleIdSubmit(e) {
    e?.preventDefault()
    const id = empId.trim().toUpperCase()
    if(!id) return setError('Please enter your Employee ID')
    setLoading(true); setError('')
    try {
      const snap = await getDocs(query(collection(db,'employees'),where('empId','==',id)))
      if(snap.empty) { setError('Employee ID not found.'); setLoading(false); return }
      const emp = {id:snap.docs[0].id,...snap.docs[0].data()}
      if(!emp.pin) { setError('No PIN set. Contact your Admin.'); setLoading(false); return }
      setEmp(emp); setStep('pin')
    } catch { setError('Connection error. Check your internet.') }
    setLoading(false)
  }

  function handlePinDigit(val,i) {
    if(!/^\d*$/.test(val)) return
    const p=[...pin]; p[i]=val.slice(-1); setPin(p); setError('')
    if(val&&i<5) pinRefs[i+1].current?.focus()
    if(val&&i===5) checkPin([...p.slice(0,5),val.slice(-1)].join(''))
  }
  function handlePinKey(e,i) {
    if(e.key==='Backspace'&&!pin[i]&&i>0) pinRefs[i-1].current?.focus()
    if(e.key==='Enter') checkPin(pin.join(''))
  }
  async function checkPin(entered) {
    const full = entered||pin.join('')
    if(full.length<4) return
    if(full===employee.pin) { setStep('bio'); await runBiometric() }
    else {
      setShake(true); setPin(['','','','','','']); setError('Wrong PIN. Try again.')
      setTimeout(()=>{ setShake(false); pinRefs[0].current?.focus() },500)
    }
  }
  async function runBiometric() {
    setBio('scanning')
    const ok = await verifyBiometric(employee.empId)
    if(ok) { setBio('success'); setTimeout(()=>{ saveSession(employee); router.replace('/') },800) }
    else { setBio('fail'); setError('Biometric did not match.'); setTimeout(()=>{ setStep('pin'); setPin(['','','','','','']); setBio('') },1500) }
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
        {/* Showroom background image */}
        <div style={{ position:'absolute', inset:0, background:'linear-gradient(135deg,#1456b8,#1a6fe8)', backgroundSize:'cover', backgroundPosition:'center', opacity:0.18 }}/>
        {/* Blue overlay */}
        <div style={{ position:'absolute', inset:0, background:'linear-gradient(135deg, #1456b8 0%, #1a6fe8 50%, #2d7ff9 100%)', opacity:0.92 }}/>
        {/* Pattern overlay */}
        <div style={{ position:'absolute', inset:0, backgroundImage:'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.08) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(255,255,255,0.05) 0%, transparent 50%)' }}/>

        <div style={{ position:'relative', zIndex:1, textAlign:'center', maxWidth:360 }}>
          {/* Logo */}
          <div style={{ marginBottom:32 }}>
            <img src="https://raw.githubusercontent.com/shaAhame/showroom-attendance/main/logo.jpeg" alt="iDealz" style={{ height:56, objectFit:'contain', filter:'brightness(0) invert(1)' }}/>
          </div>
          <h1 style={{ color:'#fff', fontSize:'2rem', fontWeight:800, marginBottom:12, lineHeight:1.2 }}>Attendance System</h1>
          <p style={{ color:'rgba(255,255,255,0.75)', fontSize:'1rem', lineHeight:1.6, marginBottom:40 }}>
            Secure biometric attendance tracking for all Idealz showrooms
          </p>

          {/* Showroom cards */}
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {[
              { name:'iDealz Prime', img:'/prime.jpeg', loc:'Galle Rd, Colombo 4' },
              { name:'iSeven Mobile', img:'/liberty.jpg', loc:'R.A. De Mel Mawatha, Colombo 3' },
              { name:'iDealz Marino', img:'/marino.jpg', loc:'Marino Mall, Colombo 3' },
            ].map(s=>(
              <div key={s.name} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', background:'rgba(255,255,255,0.12)', borderRadius:12, backdropFilter:'blur(8px)', border:'1px solid rgba(255,255,255,0.2)', textAlign:'left' }}>
                <div style={{ width:40, height:40, borderRadius:8, overflow:'hidden', flexShrink:0, border:'2px solid rgba(255,255,255,0.3)' }}>
                  <img src={s.img} alt={s.name} style={{ width:'100%', height:'100%', objectFit:'cover' }}/>
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

          {/* Mobile logo */}
          <div style={{ textAlign:'center', marginBottom:32, display:'none' }} className="mobile-logo">
            <img src="https://raw.githubusercontent.com/shaAhame/showroom-attendance/main/logo.jpeg" alt="iDealz" style={{ height:40, objectFit:'contain' }}/>
          </div>

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
              <button type="submit" style={{ ...btnPrimary, opacity:loading?0.7:1 }} disabled={loading}>
                {loading?'Checking…':'Continue →'}
              </button>
            </form>
          </>)}

          {/* Step 2: PIN */}
          {step==='pin'&&(<>
            <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px', background:'#fff', borderRadius:14, border:'1.5px solid #e2e8f0', marginBottom:24, boxShadow:'0 1px 4px rgba(0,0,0,0.06)' }}>
              <div style={{ width:44, height:44, borderRadius:'50%', background:employee?.color+'22', color:employee?.color, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:'0.9rem', flexShrink:0 }}>
                {employee?.name?.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize:'0.95rem', fontWeight:600, color:'#0f172a' }}>{employee?.name}</div>
                <div style={{ fontSize:'0.75rem', color:'#64748b' }}>{employee?.showroom?.replace('Idealz ','')} · {employee?.staffType==='backoffice'?'Back Office':'Showroom Staff'}</div>
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
            <button style={{ ...btnPrimary, opacity:filled>=4?1:0.5 }} onClick={()=>checkPin()} disabled={filled<4||loading}>
              {loading?'Verifying…':'🔐 Verify PIN'}
            </button>
            <button style={btnGhost} onClick={()=>{ setStep('id'); setPin(['','','','','','']); setError('') }}>
              ← Different account
            </button>
          </>)}

          {/* Step 3: Biometric */}
          {step==='bio'&&(
            <div style={{ textAlign:'center', padding:'20px 0' }}>
              <div style={{ width:100, height:100, borderRadius:'50%', border:`3px solid ${bioStatus==='success'?'#16a34a':bioStatus==='fail'?'#dc2626':'#1a6fe8'}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'2.8rem', margin:'0 auto 20px', background: bioStatus==='success'?'#dcfce7':bioStatus==='fail'?'#fee2e2':'#e8f1fd', transition:'all .3s' }}>
                {bioStatus==='success'?'✅':bioStatus==='fail'?'❌':'👤'}
              </div>
              <h2 style={{ fontSize:'1.4rem', fontWeight:700, color:'#0f172a', marginBottom:8 }}>
                {bioStatus==='scanning'?'Scan Face ID / Fingerprint':bioStatus==='success'?'Verified!':'Not matched'}
              </h2>
              <p style={{ color:'#64748b', fontSize:'0.85rem' }}>
                {bioStatus==='scanning'?'Look at your camera or place finger on sensor':bioStatus==='success'?'Logging you in…':'Going back to PIN…'}
              </p>
            </div>
          )}

          <div style={{ textAlign:'center', marginTop:32, fontSize:'0.72rem', color:'#94a3b8' }}>
            Secured with PIN + Biometrics
          </div>
        </div>
      </div>
    </div>

    <style>{`
      @media(max-width:768px) {
        .brand-panel { display:none !important; }
        .mobile-logo { display:block !important; }
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
