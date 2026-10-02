import { useState, useEffect } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { db, track } from '../lib/firebase'
import { collection, getDocs, addDoc, deleteDoc, doc, query, orderBy, where, updateDoc } from 'firebase/firestore'
import { getSession, clearSession, canViewReports, canManageEmployees, canViewAnalytics, getAllowedShowroom } from '../lib/auth'

const SHOWROOMS = ['Idealz Marino', 'Idealz Liberty Plaza', 'Idealz Prime']
// Display names only — Firebase still stores the keys above. Never change the keys.
const DISPLAY_NAMES = {
  'Idealz Marino':        'iDealz Marino',
  'Idealz Liberty Plaza': 'iSeven Mobile',
  'Idealz Prime':         'iDealz Prime',
}
// Full display name
function dn(showroom)      { return DISPLAY_NAMES[showroom] || showroom || '' }
// Short display name (for tabs, table cells, chips)
function dnShort(showroom) { return dn(showroom).replace('iDealz ','') }
const ICONS     = ['🏛️','🏬','🏪']
const COLORS    = ['#6c63ff','#ff6584','#43e97b','#f7c948','#38b6ff','#ff9a4a','#a78bfa','#34d399']
const ROLES     = ['employee','manager','admin']
const ROLE_LABELS = { employee:'Employee', manager:'Manager', admin:'Admin / HR', backoffice:'Back Office' }
const SHIFTS = {
  'Idealz Marino':        { showroom:{ start:'10:00', end:'20:00' } },
  'Idealz Liberty Plaza': { showroom:{ start:'10:00', end:'19:00' } },
  'Idealz Prime':         { showroom:{ start:'09:45', end:'19:30' }, backoffice:{ start:'09:30', end:'18:30' } },
}
const SHOWROOM_LOCATIONS = {
  'Idealz Marino':        { lat: 6.900183,  lng: 79.852234,  radius: 50 },
  'Idealz Liberty Plaza': { lat: 6.911688,  lng: 79.851517,  radius: 50 },
  'Idealz Prime':         { lat: 6.8912695, lng: 79.8560961, radius: 50 },
}

function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const dLat = (lat2-lat1)*Math.PI/180
  const dLng = (lng2-lng1)*Math.PI/180
  const a = Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2)
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))
}

function checkInsideShowroom(showroom, userLat, userLng) {
  const loc = SHOWROOM_LOCATIONS[showroom]
  if (!loc) return { allowed:true, distance:0, message:'' }
  const dist = Math.round(getDistance(loc.lat, loc.lng, userLat, userLng))
  if (dist <= loc.radius) return { allowed:true, distance:dist, message:`✅ You are inside ${showroom} (${dist}m away)` }
  return { allowed:false, distance:dist, message:`❌ You are ${dist}m away from ${showroom}. Please move closer to the showroom entrance.` }
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('GPS not supported')); return }
    let resolved = false
    navigator.geolocation.getCurrentPosition(
      pos => { if(resolved) return; resolved=true; resolve({lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:pos.coords.accuracy}) },
      err => {
        if(resolved) return
        navigator.geolocation.getCurrentPosition(
          pos => { if(resolved) return; resolved=true; resolve({lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:pos.coords.accuracy}) },
          err2 => { if(!resolved) reject(err2) },
          { enableHighAccuracy:false, timeout:8000, maximumAge:0 }
        )
      },
      { enableHighAccuracy:true, timeout:10000, maximumAge:0 }
    )
    setTimeout(()=>{ if(!resolved){resolved=true;reject(new Error('GPS timeout — please try again'))} },12000)
  })
}

// Which branch is this position inside? Null if none — they are not at work.
function findBranchAt(lat, lng) {
  let best = null, bestDist = Infinity
  for (const name of Object.keys(SHOWROOM_LOCATIONS)) {
    const loc = SHOWROOM_LOCATIONS[name]
    const d = getDistance(loc.lat, loc.lng, lat, lng)
    if (d <= loc.radius && d < bestDist) { best = name; bestDist = d }
  }
  return best ? { room: best, distance: Math.round(bestDist) } : null
}

function getShift(showroom, staffType='showroom') {
  const sh=SHIFTS[showroom]; if(!sh) return {start:'09:00',end:'18:00'}
  return sh[staffType]||sh.showroom
}
function today()   { return new Date().toISOString().split('T')[0] }
function nowTime() { return new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) }
function initials(name='') { return name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase() }

async function checkBiometricAvailable() {
  try { if(!window.PublicKeyCredential) return false; return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() }
  catch { return false }
}

async function verifyBiometric(empId) {
  const hasBio = await checkBiometricAvailable()
  if (!hasBio) return true
  const challenge = new Uint8Array(32); crypto.getRandomValues(challenge)
  const key = `idealz_cred_${empId}`
  try {
    const existing = localStorage.getItem(key)
    if (existing) {
      const credId = Uint8Array.from(atob(existing), c=>c.charCodeAt(0))
      await navigator.credentials.get({ publicKey:{ challenge, timeout:30000, userVerification:'required', rpId:location.hostname, allowCredentials:[{type:'public-key',id:credId,transports:['internal']}] } })
    } else {
      const cred = await navigator.credentials.create({ publicKey:{ challenge, rp:{name:'Idealz Attendance',id:location.hostname}, user:{id:new TextEncoder().encode(empId),name:empId,displayName:empId}, pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}], timeout:30000, excludeCredentials:[], authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required',residentKey:'preferred',requireResidentKey:false} } })
      localStorage.setItem(key, btoa(String.fromCharCode(...new Uint8Array(cred.rawId))))
    }
    return true
  } catch(e) { if(e.name==='NotAllowedError') return false; return true }
}

async function fbGetEmployees() {
  try { const s=await getDocs(query(collection(db,'employees'),orderBy('name'))); return s.docs.map(d=>({id:d.id,...d.data()})) }
  catch { const s=await getDocs(collection(db,'employees')); return s.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>a.name.localeCompare(b.name)) }
}
async function fbGetTodayRecords(showroom=null) {
  try {
    const constraints=[where('date','==',today())]
    if(showroom) constraints.push(where('showroom','==',showroom))
    const s=await getDocs(query(collection(db,'records'),...constraints))
    return s.docs.map(d=>({id:d.id,...d.data()}))
  } catch {
    const s=await getDocs(collection(db,'records'))
    let data=s.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.date===today())
    if(showroom) data=data.filter(r=>r.showroom===showroom)
    return data
  }
}

export default function Home() {
  const router = useRouter()
  const [session, setSession]   = useState(null)
  const [mounted, setMounted]   = useState(false)
  const [tab, setTab]           = useState('checkin')
  const [employees, setEmps]    = useState([])
  const [todayRecs, setTodayRecs] = useState([])
  const [stats, setStats]       = useState({})
  const [selRoom, setSelRoom]   = useState('')
  const [log, setLog]           = useState([])
  const [fpOverlay, setFpOv]    = useState(false)
  const [gpsStatus, setGpsStatus] = useState('')
  const [fpLabel, setFpLabel]   = useState('')
  const [leaveModal, setLeaveM] = useState(false)
  const [leaveEmp, setLeaveEmp] = useState('')
  const [leaveDur, setLeaveDur] = useState('30')
  const [leaveReason, setLeaveR]= useState('')
  const [returnModal, setReturnM]= useState(false)
  const [returnEmp, setReturnEmp]= useState('')
  const [onLeaveEmps, setOnLeaveEmps] = useState([])
  const [toast, setToast]       = useState(null)
  const [clock, setClock]       = useState('')
  const [clockDate, setClkDate] = useState('')
  const [allRecs, setAllRecs]   = useState([])
  const [loading, setLoading]   = useState(false)
  const [fRoom, setFRoom]       = useState('')
  const [fEmp, setFEmp]         = useState('')
  const [fDate, setFDate]       = useState(today())
  const [fType, setFType]       = useState('')
  const [newName, setNewName]   = useState('')
  const [newId, setNewId]       = useState('')
  const [newRoom, setNewRoom]   = useState('Idealz Marino')
  const [newST, setNewST]       = useState('showroom')
  const [newRole, setNewRole]   = useState('employee')
  const [newPin, setNewPin]     = useState('')
  const [editPinId, setEditPinId]   = useState(null)
  const [editPinVal, setEditPinVal] = useState('')
  const [empSearch, setEmpSearch]   = useState('')
  const [empFilter, setEmpFilter]   = useState('all')
  const [archiveModal, setArchiveM] = useState(false)
  const [archivePeriod, setArchivePeriod] = useState('1')
  const [archiveCount, setArchiveCount] = useState(0)
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState(false) // prevents double tap
  const [detecting, setDetecting]   = useState(false) // locating the branch on open
  const [detectFailed, setDetectFailed] = useState(false)

  useEffect(()=>{
    setMounted(true)
    const s=getSession()
    if(!s){router.replace('/login');return}
    setSession(s)
    if(s.role==='manager') setSelRoom(s.showroom)
    if(s.role==='employee') setSelRoom(s.showroom)
  },[])

  // Employees do not pick a branch — GPS says where they are.
  // Covering at another store just works, with no admin change needed.
  useEffect(()=>{
    if(!session || session.role!=='employee') return
    let cancelled=false
    setDetecting(true); setDetectFailed(false)
    getCurrentPosition()
      .then(pos=>{
        if(cancelled) return
        const found=findBranchAt(pos.lat,pos.lng)
        // At a branch -> use it. Not at any -> fall back to their own,
        // so tapping Arrive gives the usual distance message.
        setSelRoom(found ? found.room : session.showroom)
      })
      .catch(()=>{ if(!cancelled){ setSelRoom(session.showroom); setDetectFailed(true) } })
      .then(()=>{ if(!cancelled) setDetecting(false) })
    return ()=>{ cancelled=true }
  },[session])

  useEffect(()=>{
    const t=setInterval(()=>{
      const n=new Date()
      setClock(n.toLocaleTimeString('en-GB'))
      setClkDate(n.toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric'}))
    },1000); return()=>clearInterval(t)
  },[])

  useEffect(()=>{ if(!session) return; loadAll() },[session])
  useEffect(()=>{ if(session&&tab==='report') loadReports() },[tab,fRoom,fEmp,fDate,fType])

  async function loadAll() {
    const allowedRoom=getAllowedShowroom(session)
    const [emps,recs]=await Promise.all([fbGetEmployees(),fbGetTodayRecords(allowedRoom)])
    const visibleEmps=session.role==='employee'?emps.filter(e=>e.empId===session.empId):session.role==='manager'?emps.filter(e=>e.showroom===session.showroom):emps
    setEmps(visibleEmps)
    setTodayRecs(recs)
    computeStats(visibleEmps,recs)
    const logRecs=session.role==='employee'?recs.filter(r=>r.empId===session.empId):recs
    const sorted=[...logRecs].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))
    setLog(sorted.map(r=>({id:r.id||r.createdAt,empId:r.empId,empName:r.empName,showroom:r.showroom,type:r.type,time:r.time,reason:r.reason,duration:r.duration})))
  }

  function computeStats(emps,recs) {
    const arrived=new Set(recs.filter(r=>r.type==='arrive').map(r=>r.empId)).size
    const departed=new Set(recs.filter(r=>r.type==='depart').map(r=>r.empId)).size
    const onLeave=new Set(recs.filter(r=>r.type==='leave').map(r=>r.empId)).size
    const byShowroom={}
    SHOWROOMS.forEach(s=>{byShowroom[s]=new Set(recs.filter(r=>r.showroom===s&&r.type==='arrive').map(r=>r.empId)).size})
    setStats({arrived,departed,onLeave,byShowroom})
    const currentlyOnLeave=[]
    const empIds=[...new Set(recs.map(r=>r.empId))]
    empIds.forEach(empId=>{
      const empRecs=recs.filter(r=>r.empId===empId).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0))
      const lastRec=empRecs[empRecs.length-1]
      if(lastRec?.type==='leave'){
        const leaveRec=lastRec
        const now=new Date()
        const [h,m,s]=leaveRec.time.split(':').map(Number)
        const leaveTime=new Date(); leaveTime.setHours(h,m,s||0,0)
        const minutesGone=Math.round((now-leaveTime)/60000)
        const expectedDur=leaveRec.duration||30
        const overdue=minutesGone>expectedDur
        const emp=emps.find(e=>e.empId===empId)
        if(emp) currentlyOnLeave.push({...emp,leaveRec,minutesGone,expectedDur,overdue,overdueBy:overdue?minutesGone-expectedDur:0})
      }
    })
    setOnLeaveEmps(currentlyOnLeave)
  }

  function showToast(msg,type='success'){setToast({msg,type});setTimeout(()=>setToast(null),3200)}

  const empForRoom=selRoom?employees.filter(e=>e.showroom===selRoom):employees

  async function doAction(type,empOverrideId=null) {
    // Prevent double tap — if already processing, ignore
    if (actionLoading) return showToast('⏳ Please wait…','info')
    setActionLoading(true)
    try {
      await _doAction(type, empOverrideId)
    } finally {
      setActionLoading(false)
    }
  }

  async function _doAction(type,empOverrideId=null) {
    const eid=empOverrideId||(session?.role==='employee'?employees[0]?.id:null)
    if(!eid&&session?.role!=='employee') return showToast('Select an employee.','error')
    if(!selRoom) return showToast('Select a showroom first.','error')
    const emp=employees.find(e=>e.id===eid)||employees[0]
    if(!emp) return showToast('Employee not found.','error')

    // Check Firebase directly for duplicate + enforce arrive before depart
    try {
      const todaySnap=await getDocs(query(collection(db,'records'),where('empId','==',emp.empId),where('date','==',today())))
      const todayEmpRecs=todaySnap.docs.map(d=>d.data())

      // Block duplicate
      const alreadyDone=todayEmpRecs.find(r=>r.type===type)
      if(alreadyDone){
        const label=type==='arrive'?'Arrival':'Departure'
        track('duplicate_blocked',{ showroom:selRoom, action:type })
        return showToast(`❌ ${emp.name} already recorded ${label} today at ${alreadyDone.time}`,'error')
      }

      // Must arrive before depart
      if(type==='depart'){
        const hasArrived=todayEmpRecs.find(r=>r.type==='arrive')
        if(!hasArrived) return showToast(`❌ ${emp.name} has not arrived yet. Please check in first before departing.`,'error')
      }
    } catch(err) {
      // Fallback to local state check
      const alreadyDone=todayRecs.find(r=>r.empId===emp.empId&&r.type===type)
      if(alreadyDone) return showToast(`❌ ${emp.name} already recorded ${type==='arrive'?'Arrival':'Departure'} today at ${alreadyDone.time}`,'error')
      if(type==='depart'){
        const hasArrived=todayRecs.find(r=>r.empId===emp.empId&&r.type==='arrive')
        if(!hasArrived) return showToast(`❌ ${emp.name} has not arrived yet. Please check in first.`,'error')
      }
    }

    setGpsStatus('checking')
    showToast('📍 Checking your location…','info')
    try {
      const pos=await getCurrentPosition()
      const check=checkInsideShowroom(selRoom,pos.lat,pos.lng)
      if(!check.allowed){
        track('gps_blocked',{ showroom:selRoom, distance:check.distance, action:type })
        setGpsStatus('fail');showToast(check.message,'error');setTimeout(()=>setGpsStatus(''),3000);return
      }
      setGpsStatus('ok')
    } catch(e) {
      setGpsStatus('fail')
      track('gps_failed',{ showroom:selRoom, reason:e.code===1?'permission_denied':e.code===2?'signal_weak':'timeout' })
      if(e.code===1) showToast('❌ Location permission denied. Go to browser Settings → Allow Location.','error')
      else if(e.code===2) showToast('❌ GPS signal weak. Move to an open area and try again.','error')
      else if(e.message&&e.message.includes('timeout')) showToast('❌ GPS timed out. Make sure Location is ON and try again.','error')
      else showToast('❌ Could not get location. Check your GPS is turned ON.','error')
      setTimeout(()=>setGpsStatus(''),4000); return
    }

    setFpLabel(type==='arrive'?`Verifying arrival — ${emp.name}`:`Verifying departure — ${emp.name}`)
    setFpOv(true)
    const ok=await verifyBiometric(emp.empId)
    setFpOv(false); setGpsStatus('')
    if(!ok){ track('biometric_failed',{ showroom:selRoom, action:type }); return showToast('Face ID / fingerprint did not match.','error') }

    const homeShowroom=emp.showroom||session.showroom
    const rec={empId:emp.empId,empName:emp.name,showroom:selRoom,homeShowroom,
               isCovering:selRoom!==homeShowroom,
               type,date:today(),time:nowTime(),reason:'',duration:0}
    await addDoc(collection(db,'records'),{...rec,createdAt:Date.now()})
    track(type==='arrive'?'checkin_success':'checkout_success',{ showroom:selRoom, role:session.role })
    setLog(p=>[{...rec,id:Date.now()},...p])
    setTodayRecs(p=>{const n=[...p,rec];computeStats(employees,n);return n})
    showToast(`${type==='arrive'?'✅ Arrived':'🔴 Departed'}: ${emp.name}`)
  }

  async function submitLeave() {
    const eid=session?.role==='employee'?employees[0]?.id:leaveEmp
    if(!eid) return showToast('Select an employee.','error')
    if(!selRoom) return showToast('Select a showroom first.','error')
    const emp=employees.find(e=>e.id===eid)||employees[0]
    if(!emp) return
    setGpsStatus('checking'); showToast('📍 Checking your location…','info')
    try {
      const pos=await getCurrentPosition()
      const check=checkInsideShowroom(selRoom,pos.lat,pos.lng)
      if(!check.allowed){setGpsStatus('fail');showToast(check.message,'error');setTimeout(()=>setGpsStatus(''),3000);return}
      setGpsStatus('ok')
    } catch(e) {
      setGpsStatus('fail')
      if(e.code===1) showToast('❌ Location permission denied. Go to Settings → Allow Location.','error')
      else if(e.message&&e.message.includes('timeout')) showToast('❌ GPS timed out. Make sure Location is ON and try again.','error')
      else showToast('❌ Could not get location. Check your GPS is turned ON.','error')
      setTimeout(()=>setGpsStatus(''),4000); return
    }
    setFpLabel(`Short leave — ${emp.name}`); setFpOv(true)
    const ok=await verifyBiometric(emp.empId)
    setFpOv(false); setGpsStatus('')
    if(!ok) return showToast('Face ID / fingerprint did not match.','error')
    const homeShowroom=emp.showroom||session.showroom
    const rec={empId:emp.empId,empName:emp.name,showroom:selRoom,homeShowroom,
               isCovering:selRoom!==homeShowroom,
               type:'leave',date:today(),time:nowTime(),reason:leaveReason||'Short leave',duration:parseInt(leaveDur)}
    await addDoc(collection(db,'records'),{...rec,createdAt:Date.now()})
    setLog(p=>[{...rec,id:Date.now()},...p])
    setTodayRecs(p=>{const n=[...p,rec];computeStats(employees,n);return n})
    setLeaveM(false); setLeaveR('')
    showToast(`🕐 Short leave: ${emp.name} (~${leaveDur} min)`)
  }

  async function submitReturn() {
    const eid=session?.role==='employee'?employees[0]?.id:returnEmp
    if(!eid) return showToast('Select an employee.','error')
    if(!selRoom) return showToast('Select a showroom first.','error')
    const emp=employees.find(e=>e.id===eid)||employees[0]
    if(!emp) return
    setGpsStatus('checking'); showToast('📍 Checking your location…','info')
    try {
      const pos=await getCurrentPosition()
      const check=checkInsideShowroom(selRoom,pos.lat,pos.lng)
      if(!check.allowed){setGpsStatus('fail');showToast(check.message,'error');setTimeout(()=>setGpsStatus(''),3000);return}
      setGpsStatus('ok')
    } catch(e) {
      setGpsStatus('fail')
      if(e.code===1) showToast('❌ Location permission denied. Go to Settings → Allow Location.','error')
      else if(e.message&&e.message.includes('timeout')) showToast('❌ GPS timed out. Make sure Location is ON and try again.','error')
      else showToast('❌ Could not get location. Check your GPS is turned ON.','error')
      setTimeout(()=>setGpsStatus(''),4000); return
    }
    setFpLabel(`Return from leave — ${emp.name}`); setFpOv(true)
    const ok=await verifyBiometric(emp.empId)
    setFpOv(false); setGpsStatus('')
    if(!ok) return showToast('Face ID / fingerprint did not match.','error')
    const leaveRec=onLeaveEmps.find(e=>e.id===eid)?.leaveRec
    const actualMinutes=onLeaveEmps.find(e=>e.id===eid)?.minutesGone||0
    const expectedDur=leaveRec?.duration||30
    const overdue=actualMinutes>expectedDur
    const overdueBy=overdue?actualMinutes-expectedDur:0
    const homeShowroom=emp.showroom||session.showroom
    const rec={empId:emp.empId,empName:emp.name,showroom:selRoom,homeShowroom,isCovering:selRoom!==homeShowroom,type:'return',date:today(),time:nowTime(),reason:overdue?`Returned ${overdueBy} min late (expected ${expectedDur} min, took ${actualMinutes} min)`:`Returned on time (${actualMinutes} min)`,duration:actualMinutes,expectedDuration:expectedDur,overdue,overdueBy}
    await addDoc(collection(db,'records'),{...rec,createdAt:Date.now()})
    setLog(p=>[{...rec,id:Date.now()},...p])
    setTodayRecs(p=>{const n=[...p,rec];computeStats(employees,n);return n})
    setReturnM(false); setReturnEmp('')
    if(overdue) showToast(`⚠️ ${emp.name} returned ${overdueBy} min LATE!`,'error')
    else showToast(`✅ ${emp.name} returned on time (${actualMinutes} min)`)
  }

  async function countOldRecords(months) {
    const cutoff=new Date(); cutoff.setMonth(cutoff.getMonth()-parseInt(months))
    const cutoffStr=cutoff.toISOString().split('T')[0]
    const snap=await getDocs(collection(db,'records'))
    const old=snap.docs.filter(d=>(d.data().date||'')<cutoffStr)
    return {docs:old,cutoffStr}
  }
  async function openArchiveModal() { setArchiveLoading(true);setArchiveM(true);const{docs}=await countOldRecords(archivePeriod);setArchiveCount(docs.length);setArchiveLoading(false) }
  async function handleArchivePeriodChange(months) { setArchivePeriod(months);setArchiveLoading(true);const{docs}=await countOldRecords(months);setArchiveCount(docs.length);setArchiveLoading(false) }

  async function exportAndDeleteOldRecords() {
    setArchiveLoading(true)
    try {
      const{docs,cutoffStr}=await countOldRecords(archivePeriod)
      if(docs.length===0){showToast('No records found for this period.','info');setArchiveM(false);setArchiveLoading(false);return}
      // Load SheetJS
      if(!window.XLSX){ await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s)}) }
      const XL=window.XLSX
      const wb=XL.utils.book_new()
      const hdrs=['Employee','Showroom','Type','Time','Date','Reason','Duration(min)','Overdue']
      const rows=[hdrs,...docs.map(d=>{const r=d.data();return[r.empName||'',r.showroom||'',r.type||'',r.time||'',r.date||'',r.reason||'',r.duration||'',r.overdue?'Yes':'No']})]
      const ws=XL.utils.aoa_to_sheet(rows)
      ws['!cols']=[22,20,10,10,12,30,14,10].map(w=>({wch:w}))
      hdrs.forEach((_,ci)=>{const ref=XL.utils.encode_cell({r:0,c:ci});if(ws[ref])ws[ref].s={font:{bold:true,color:{rgb:'FFFFFF'},sz:10},fill:{patternType:'solid',fgColor:{rgb:'1A6FE8'}},alignment:{horizontal:'center'}}})
      XL.utils.book_append_sheet(wb,ws,'Archive')
      XL.writeFile(wb,`idealz-archive-before-${cutoffStr}.xlsx`)
      await Promise.all(docs.map(d=>deleteDoc(doc(db,'records',d.id))))
      showToast(`✅ Exported & deleted ${docs.length} records`)
      setArchiveM(false)
    } catch(e) { showToast('Error during archive. Try again.','error') }
    setArchiveLoading(false)
  }

  async function loadReports() {
    setLoading(true)
    try {
      const snap=await getDocs(collection(db,'records'))
      let data=snap.docs.map(d=>({id:d.id,...d.data()}))
      if(session?.role==='manager') data=data.filter(r=>r.showroom===session.showroom)
      if(fRoom)  data=data.filter(r=>r.showroom===fRoom)
      if(fEmp)   data=data.filter(r=>r.empId===fEmp)
      if(fDate)  data=data.filter(r=>r.date===fDate)
      if(fType)  data=data.filter(r=>r.type===fType)
      setAllRecs(data.sort((a,b)=>b.createdAt-a.createdAt))
    } catch { showToast('Error loading records.','error') }
    setLoading(false)
  }

  async function exportExcel() {
    if(!window.XLSX){ await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s)}) }
    const XL=window.XLSX
    const wb=XL.utils.book_new()

    const SHIFT_MAP={'Idealz Marino':{showroom:['10:00','20:00']},'Idealz Liberty Plaza':{showroom:['10:00','19:00']},'Idealz Prime':{showroom:['09:45','19:30'],backoffice:['09:30','18:30']}}
    function toMin(t){if(!t||t==='—')return null;const p=t.split(':');return parseInt(p[0])*60+parseInt(p[1])}
    function fmtH(m){if(m==null||m<=0)return'0h 0m';return`${Math.floor(m/60)}h ${m%60}m`}
    function getShiftTimes(showroom,stype='showroom'){const sh=SHIFT_MAP[showroom]||{};return sh[stype]||sh['showroom']||['09:00','18:00']}

    // Group by employee+date
    const grouped={}
    allRecs.forEach(r=>{
      const k=`${r.empName}||${r.showroom}||${r.date}`
      if(!grouped[k]) grouped[k]=[]
      grouped[k].push(r)
    })

    // Build daily rows
    const dailyRows=[]
    Object.values(grouped).forEach(recs=>{
      const r0=recs[0]
      const arrives=recs.filter(r=>r.type==='arrive').sort((a,b)=>a.time?.localeCompare(b.time))
      const departs=recs.filter(r=>r.type==='depart').sort((a,b)=>b.time?.localeCompare(a.time))
      const leaves=recs.filter(r=>r.type==='leave')
      const arrive=arrives[0]?.time||null
      const depart=departs[0]?.time||null
      const leaveDurTotal=leaves.reduce((a,r)=>a+(parseInt(r.duration)||0),0)
      const leaveRsn=leaves.map(r=>r.reason).filter(Boolean).join('; ')
      const emp=employees.find(e=>e.empId===r0.empId)||{}
      const [shStart,shEnd]=getShiftTimes(r0.showroom,emp.staffType||'showroom')
      const sMin=toMin(shStart),eMin=toMin(shEnd)
      const aMin=toMin(arrive),dMin=toMin(depart)
      const lateBy=aMin&&aMin>sMin?aMin-sMin:0
      const earlyExit=dMin&&dMin<eMin?eMin-dMin:0
      const workMin=aMin&&dMin?Math.max(0,dMin-aMin-leaveDurTotal):null
      const targetMin=eMin-sMin
      const otMin=workMin!=null?workMin-targetMin:null
      const status=!arrive?'Absent':workMin&&workMin<targetMin/2?'Half Day':lateBy>15?'Late':'Present'
      dailyRows.push({
        Employee:r0.empName,Showroom:dnShort(r0.showroom),Date:r0.date,
        Day:r0.date?new Date(r0.date).toLocaleDateString('en-GB',{weekday:'short'}):'',
        Status:status,'Arrive Time':arrive||'—','Depart Time':depart||'—',
        'Shift Start':shStart,'Shift End':shEnd,
        'Late By':lateBy>0?`${lateBy}m`:'—','Early Exit':earlyExit>0?`${earlyExit}m`:'—',
        'Short Leave':leaveDurTotal>0?`${leaveDurTotal}m`:'—','Leave Reason':leaveRsn||'—',
        'Work Hours':workMin!=null?fmtH(workMin):'No departure','Target Hours':fmtH(targetMin),
        'OT / Short':otMin!=null?(otMin>=0?'+':'')+fmtH(Math.abs(otMin)):'—',
        'OT Flag':otMin!=null?(otMin>0?'OT':otMin<0?'Short':'On Time'):'—',
        _lateRaw:lateBy,_otRaw:otMin,_workRaw:workMin
      })
    })
    dailyRows.sort((a,b)=>a.Showroom?.localeCompare(b.Showroom)||a.Employee?.localeCompare(b.Employee)||a.Date?.localeCompare(b.Date))

    // Sheet 1: Daily Attendance
    const cols1=['Employee','Showroom','Date','Day','Status','Arrive Time','Depart Time','Shift Start','Shift End','Late By','Early Exit','Short Leave','Leave Reason','Work Hours','Target Hours','OT / Short','OT Flag']
    const ws1Data=[cols1,...dailyRows.map(r=>cols1.map(c=>r[c]))]
    const ws1=XL.utils.aoa_to_sheet(ws1Data)
    ws1['!cols']=[22,12,11,8,9,10,10,9,9,8,10,10,22,13,12,12,9].map(w=>({wch:w}))
    cols1.forEach((_,ci)=>{const ref=XL.utils.encode_cell({r:0,c:ci});if(ws1[ref])ws1[ref].s={font:{bold:true,color:{rgb:'FFFFFF'},sz:10},fill:{patternType:'solid',fgColor:{rgb:'1A6FE8'}},alignment:{horizontal:'center'}}})
    XL.utils.book_append_sheet(wb,ws1,'Daily Attendance')

    // Sheet 2: Employee Summary
    const empMap={}
    dailyRows.forEach(row=>{
      const k=row.Employee+'||'+row.Showroom
      if(!empMap[k]) empMap[k]={name:row.Employee,show:row.Showroom,days:0,absent:0,late:0,leaves:0,workMin:0,otMin:0}
      if(row.Status==='Absent'){empMap[k].absent++}
      else{empMap[k].days++;if(row._lateRaw>0)empMap[k].late++;if(row['Short Leave']!=='—')empMap[k].leaves++;if(row._workRaw)empMap[k].workMin+=row._workRaw;if(row._otRaw)empMap[k].otMin+=row._otRaw}
    })
    const sumHdrs=['Employee','Showroom','Days Present','Days Absent','Late Arrivals','Short Leaves','Total Work Hrs','Total OT/Short','Avg Hrs/Day','Performance']
    const sumRows=Object.values(empMap).map(e=>{
      const avg=e.days>0?Math.round(e.workMin/e.days):0
      const score=Math.max(0,100-e.late*3-e.absent*5)
      const perf=score>=90?'Excellent':score>=75?'Good':score>=60?'Average':'Needs Improvement'
      return[e.name,e.show,e.days,e.absent,e.late,e.leaves,fmtH(e.workMin),(e.otMin>=0?'+':'')+fmtH(Math.abs(e.otMin)),fmtH(avg),perf]
    })
    const ws2=XL.utils.aoa_to_sheet([sumHdrs,...sumRows])
    ws2['!cols']=[22,14,13,12,14,12,14,14,12,16].map(w=>({wch:w}))
    sumHdrs.forEach((_,ci)=>{const ref=XL.utils.encode_cell({r:0,c:ci});if(ws2[ref])ws2[ref].s={font:{bold:true,color:{rgb:'FFFFFF'},sz:10},fill:{patternType:'solid',fgColor:{rgb:'1A6FE8'}},alignment:{horizontal:'center'}}})
    XL.utils.book_append_sheet(wb,ws2,'Employee Summary')

    // Sheet 3: OT Report
    const otHdrs=['Employee','Showroom','Date','Arrive Time','Depart Time','Work Hours','Target Hours','OT / Short','Flag']
    const otRows=dailyRows.filter(r=>r['OT Flag']==='OT'||r['OT Flag']==='Short').sort((a,b)=>Math.abs(b._otRaw||0)-Math.abs(a._otRaw||0))
    const ws3=XL.utils.aoa_to_sheet([otHdrs,...otRows.map(r=>otHdrs.map(c=>r[c]||r['OT Flag']))])
    ws3['!cols']=[22,12,11,10,10,12,12,12,9].map(w=>({wch:w}))
    otHdrs.forEach((_,ci)=>{const ref=XL.utils.encode_cell({r:0,c:ci});if(ws3[ref])ws3[ref].s={font:{bold:true,color:{rgb:'FFFFFF'},sz:10},fill:{patternType:'solid',fgColor:{rgb:'1A6FE8'}},alignment:{horizontal:'center'}}})
    XL.utils.book_append_sheet(wb,ws3,'OT & Hours')

    // Sheet 4: No Departure (possible on duty)
    const noDeptHdrs=['Employee','Showroom','Date','Arrive Time','No Departure Recorded','Notes']
    const noDeptRows=dailyRows.filter(r=>r['Arrive Time']!=='—'&&r['Depart Time']==='—')
    const ws4=XL.utils.aoa_to_sheet([noDeptHdrs,...noDeptRows.map(r=>[r.Employee,r.Showroom,r.Date,r['Arrive Time'],'No departure recorded — check if on company duty',''])])
    ws4['!cols']=[22,12,11,12,30,25].map(w=>({wch:w}))
    noDeptHdrs.forEach((_,ci)=>{const ref=XL.utils.encode_cell({r:0,c:ci});if(ws4[ref])ws4[ref].s={font:{bold:true,color:{rgb:'FFFFFF'},sz:10},fill:{patternType:'solid',fgColor:{rgb:'D97706'}},alignment:{horizontal:'center'}}})
    XL.utils.book_append_sheet(wb,ws4,'No Departure Records')

    XL.writeFile(wb,`idealz-attendance-${fDate||today()}.xlsx`)
    showToast('✅ Excel report downloaded!')
  }

  async function addEmployee() {
    if(!newName||!newId) return showToast('Fill in name and Employee ID.','error')
    if(!newPin||newPin.length<4) return showToast('PIN must be at least 4 digits.','error')
    if(!/^\d+$/.test(newPin)) return showToast('PIN must be digits only.','error')
    const allEmps=await fbGetEmployees()
    if(allEmps.find(e=>e.empId===newId)) return showToast('Employee ID already exists.','error')
    const color=COLORS[Math.floor(Math.random()*COLORS.length)]
    try {
      await addDoc(collection(db,'employees'),{empId:newId,name:newName,showroom:newRoom,staffType:newST,role:newRole,pin:newPin,color,createdAt:Date.now()})
      showToast(`✅ ${newName} added!`)
      setNewName('');setNewId('');setNewPin('')
      loadAll()
    } catch { showToast('Error adding employee.','error') }
  }

  async function removeEmployee(id,name) {
    try {
      await deleteDoc(doc(db,'employees',id))
      setEmps(prev=>prev.filter(e=>e.id!==id))
      showToast(`🗑️ ${name} removed.`)
      setTimeout(()=>loadAll(),1500)
    } catch { showToast('Error removing.','error') }
  }

  async function savePinEdit(empDocId) {
    if(!editPinVal||editPinVal.length<4) return showToast('PIN must be at least 4 digits.','error')
    if(!/^\d+$/.test(editPinVal)) return showToast('PIN must be digits only.','error')
    try { await updateDoc(doc(db,'employees',empDocId),{pin:editPinVal}); showToast('✅ PIN updated!');setEditPinId(null);setEditPinVal('');loadAll() }
    catch { showToast('Error updating PIN.','error') }
  }

  function logout(){clearSession();router.replace('/login')}

  if(!mounted||!session) return <div style={{color:'#64748b',textAlign:'center',padding:60,fontFamily:'Inter,sans-serif'}}>Loading…</div>

  const typeLabel={arrive:'Arrive',depart:'Depart',leave:'Short Leave',return:'Returned'}
  const logColors={arrive:'#43e97b',depart:'#ff6584',leave:'#f7c948',return:'#a78bfa'}
  const roleColor={employee:'#6b6b8a',manager:'#38b6ff',admin:'#a78bfa',backoffice:'#f7c948'}

  return (<>
    <Head>
      <title>Idealz Attendance</title>
      <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
      <meta name="theme-color" content="#1a6fe8"/>
      <meta name="apple-mobile-web-app-capable" content="yes"/>
    </Head>
    <div style={{position:'relative',zIndex:1}}>

      <nav className="nav-bar" style={S.nav}>
        <div style={S.brand}>
          <span style={{fontSize:'0.9rem',fontWeight:700,color:'#0f172a'}}>Attendance</span>
        </div>
        <div className="desktop-tabs" style={S.tabs}>
          <button style={{...S.tab,...(tab==='checkin'?S.tabOn:{})}} onClick={()=>setTab('checkin')}>Check In/Out</button>
          {canViewReports(session)&&<button style={{...S.tab,...(tab==='report'?S.tabOn:{})}} onClick={()=>setTab('report')}>Reports</button>}
          {canManageEmployees(session)&&<button style={{...S.tab,...(tab==='admin'?S.tabOn:{})}} onClick={()=>setTab('admin')}>Admin</button>}
          {canViewAnalytics(session)&&<a href="/analytics" style={{...S.tab,textDecoration:'none',display:'flex',alignItems:'center',color:'#64748b'}}>Analytics</a>}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <div className="desktop-clock" style={{textAlign:'right'}}>
            <div style={{fontSize:'0.8rem',color:'#0f172a'}}>{clock}</div>
            <div style={{fontSize:'0.68rem',color:'#64748b'}}>{clockDate}</div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:8,padding:'6px 12px',background:'#f8fafc',borderRadius:20,border:'1px solid #e2e8f0'}}>
            <div style={{width:28,height:28,borderRadius:'50%',background:session.color+'33',color:session.color,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:'0.72rem'}}>{initials(session.name)}</div>
            <div className="desktop-clock">
              <div style={{fontSize:'0.78rem',color:'#0f172a',fontWeight:500}}>{session.name.split(' ')[0]}</div>
              <div style={{fontSize:'0.65rem',color:roleColor[session.role]||'#64748b'}}>{ROLE_LABELS[session.role]}</div>
            </div>
            <button onClick={logout} style={{background:'none',border:'none',color:'#64748b',cursor:'pointer',fontSize:'0.72rem',marginLeft:4,padding:'2px 6px',borderRadius:4}}>Sign out</button>
          </div>
        </div>
      </nav>

      {session.role==='employee'&&<div style={{background:'#e8f1fd',borderBottom:'1px solid #bfdbfe',padding:'8px 24px',fontSize:'0.76rem',color:'#1456b8',textAlign:'center',fontWeight:500}}>👋 Welcome, {session.name} · You can check in and out for yourself only</div>}
      {session.role==='manager'&&<div style={{background:'#f0f9ff',borderBottom:'1px solid #bae6fd',padding:'8px 24px',fontSize:'0.76rem',color:'#0369a1',textAlign:'center',fontWeight:500}}>👔 Manager view · {dn(session.showroom)}</div>}

      {tab==='checkin'&&<div className="page-content" style={S.page}>
        <div className="page-h1" style={S.h1}>{session.role==='employee'?`Hi, ${session.name.split(' ')[0]}! 👋`:'Check In / Out'}</div>
        <div style={S.sub}>{session.role==='employee'?'Tap below to check in or out':'Select showroom → employee → biometric'}</div>

        {/* Showroom selector — employees only see their own showroom */}
        <div className="room-grid" style={{...S.roomGrid,gridTemplateColumns:session.role==='employee'?'1fr':session.role==='manager'?'1fr':'repeat(3,1fr)'}}>
          {SHOWROOMS.filter(s=>{
            // Employee sees the branch GPS put them at, not a chooser
            if(session.role==='employee') return s===(selRoom||session.showroom)
            if(session.role==='manager') return s===session.showroom
            return true
          }).map((s,i)=>{
            const icons=['🏛️','📱','🏪']
            const idx=SHOWROOMS.indexOf(s)
            const isSelected=selRoom===s
            const checkedIn=stats.byShowroom?.[s]??0
            // For employee: show their own check-in status
            const empTodayRec=todayRecs.find(r=>r.empId===session.empId&&r.type==='arrive')
            const empCheckedIn=session.role==='employee'&&empTodayRec
            return(
              <div key={s}
                style={{...S.roomCard,...(isSelected?S.roomOn:{}),cursor:'pointer',padding:0}}
                onClick={()=>setSelRoom(s)}>
                {/* Color header bar instead of photo */}
                <div style={{height:8,background:isSelected?'#1a6fe8':'#e2e8f0',borderRadius:'14px 14px 0 0',transition:'background .2s'}}/>
                <div style={{padding:'16px 16px 14px'}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                    <span style={{fontSize:'1.5rem'}}>{icons[idx]}</span>
                    {isSelected&&<span style={{fontSize:'0.65rem',color:'#fff',background:'#1a6fe8',padding:'2px 8px',borderRadius:20,fontWeight:600}}>✓ Selected</span>}
                  </div>
                  <div style={{fontWeight:700,fontSize:'0.88rem',color:isSelected?'#1a6fe8':'#0f172a',marginBottom:4}}>{dn(s)}</div>
                  {session.role==='employee'
                    ? <div style={{fontSize:'0.72rem',color:empCheckedIn?'#16a34a':'#64748b',fontWeight:empCheckedIn?600:400}}>
                        {empCheckedIn?`✅ You checked in at ${empTodayRec.time}`:'Not checked in yet'}
                      </div>
                    : <div style={{fontSize:'0.72rem',color:'#64748b'}}>
                        <span style={{color:'#16a34a',fontWeight:600}}>{checkedIn}</span> checked in today
                      </div>
                  }
                </div>
              </div>
            )
          })}
        </div>

        {onLeaveEmps.filter(e=>!selRoom||e.showroom===selRoom).length>0&&(
          <div style={{marginBottom:16,borderRadius:12,overflow:'hidden',border:'1px solid #fde68a'}}>
            <div style={{padding:'8px 16px',background:'#fef3c7',fontSize:'0.76rem',fontWeight:600,color:'#92400e',borderBottom:'1px solid #fde68a'}}>🕐 Currently on short leave</div>
            {onLeaveEmps.filter(e=>!selRoom||e.showroom===selRoom).map(e=>(
              <div key={e.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 16px',background:'#fff',borderBottom:'1px solid #f1f5f9'}}>
                <div style={{width:30,height:30,borderRadius:'50%',background:e.color+'22',color:e.color,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:'0.72rem',flexShrink:0}}>{initials(e.name)}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:'0.82rem',fontWeight:500,color:'#0f172a'}}>{e.name}</div>
                  <div style={{fontSize:'0.7rem',color:'#64748b'}}>Left at {e.leaveRec.time} · {e.leaveRec.reason} · Expected {e.expectedDur} min</div>
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <div style={{fontSize:'0.8rem',fontWeight:700,color:e.overdue?'#dc2626':'#16a34a'}}>{e.minutesGone} min</div>
                  {e.overdue?<div style={{fontSize:'0.68rem',color:'#dc2626'}}>⚠️ {e.overdueBy} min overdue!</div>:<div style={{fontSize:'0.68rem',color:'#16a34a'}}>On time</div>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Where GPS says they are */}
        {session.role==='employee'&&detecting&&(
          <div style={{marginBottom:16,padding:'10px 16px',borderRadius:10,background:'#e8f1fd',border:'1px solid #bfdbfe',display:'flex',alignItems:'center',gap:10,fontSize:'0.82rem',color:'#1456b8'}}>
            <span style={{fontSize:'1.1rem'}}>📍</span>
            <span>Finding which branch you are at…</span>
          </div>
        )}
        {session.role==='employee'&&!detecting&&selRoom&&selRoom!==session.showroom&&(
          <div style={{marginBottom:16,padding:'10px 16px',borderRadius:10,background:'#fef3c7',border:'1px solid #fde68a',display:'flex',alignItems:'center',gap:10,fontSize:'0.82rem',color:'#92400e'}}>
            <span style={{fontSize:'1.1rem'}}>🔄</span>
            <span>You are at <strong>{dn(selRoom)}</strong> today — covering, not your usual branch. Shift times follow {dnShort(selRoom)}.</span>
          </div>
        )}
        {session.role==='employee'&&!detecting&&detectFailed&&(
          <div style={{marginBottom:16,padding:'10px 16px',borderRadius:10,background:'#fee2e2',border:'1px solid #fca5a5',display:'flex',alignItems:'center',gap:10,fontSize:'0.82rem',color:'#dc2626'}}>
            <span style={{fontSize:'1.1rem'}}>❌</span>
            <span>Could not read your location. Turn Location on, then reload the page.</span>
          </div>
        )}

        {gpsStatus&&(
          <div style={{marginBottom:16,padding:'10px 16px',borderRadius:10,background:gpsStatus==='checking'?'#e8f1fd':gpsStatus==='ok'?'#dcfce7':'#fee2e2',border:`1px solid ${gpsStatus==='checking'?'#bfdbfe':gpsStatus==='ok'?'#bbf7d0':'#fca5a5'}`,display:'flex',alignItems:'center',gap:10,fontSize:'0.82rem',color:gpsStatus==='checking'?'#1456b8':gpsStatus==='ok'?'#166534':'#dc2626'}}>
            <span style={{fontSize:'1.1rem'}}>{gpsStatus==='checking'?'📍':gpsStatus==='ok'?'✅':'❌'}</span>
            <span>{gpsStatus==='checking'?'Getting your GPS location…':gpsStatus==='ok'?'Location verified — you are at the showroom':'Location check failed'}</span>
          </div>
        )}

        <div className="action-grid" style={S.grid2}>
          <div className="card-pad" style={S.card}>
            <h3 style={S.cardH}>Arrival / Departure</h3>
            {!selRoom&&<div style={S.warnBox}>👆 Select your showroom above first</div>}
            {session.role!=='employee'&&(
              <select style={S.sel} value={leaveEmp} onChange={e=>setLeaveEmp(e.target.value)} disabled={!selRoom}>
                <option value="">— Select Employee —</option>
                {empForRoom.map(e=><option key={e.id} value={e.id}>{e.name} · {ROLE_LABELS[e.staffType]||''}</option>)}
              </select>
            )}
            {session.role==='employee'&&employees[0]&&(
              <div style={{padding:'10px 14px',background:'#f8fafc',borderRadius:10,border:'1px solid #e2e8f0',marginBottom:12,display:'flex',alignItems:'center',gap:10}}>
                <div style={{width:34,height:34,borderRadius:'50%',background:session.color+'33',color:session.color,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:'0.78rem'}}>{initials(session.name)}</div>
                <div>
                  <div style={{fontSize:'0.85rem',fontWeight:500,color:'#0f172a'}}>{session.name}</div>
                  <div style={{fontSize:'0.7rem',color:'#64748b'}}>{getShift(selRoom||session.showroom,session.staffType).start} – {getShift(selRoom||session.showroom,session.staffType).end}</div>
                </div>
              </div>
            )}
            <button className="fp-btn" disabled={actionLoading} style={{...S.btn,background:'linear-gradient(135deg,#43e97b,#38f9d7)',color:'#0a0a0f',marginBottom:10,opacity:selRoom&&!actionLoading?1:0.5}} onClick={()=>{const eid=session.role==='employee'?employees[0]?.id:leaveEmp;doAction('arrive',eid)}}>
              {actionLoading?'⏳ Processing…':'👤 Face ID — Arrive'}
            </button>
            <button className="fp-btn" disabled={actionLoading} style={{...S.btn,background:'linear-gradient(135deg,#ff6584,#ff9a4a)',color:'#0a0a0f',marginBottom:10,opacity:selRoom&&!actionLoading?1:0.5}} onClick={()=>{const eid=session.role==='employee'?employees[0]?.id:leaveEmp;doAction('depart',eid)}}>
              {actionLoading?'⏳ Processing…':'👤 Face ID — Depart'}
            </button>
            <button className="fp-btn" disabled={actionLoading} style={{...S.btn,background:'linear-gradient(135deg,#f7c948,#ff9a4a)',color:'#0a0a0f',marginBottom:10,opacity:selRoom&&!actionLoading?1:0.5}} onClick={()=>{if(!selRoom)return showToast('Select a showroom first.','error');setLeaveM(true)}}>
              🕐 Short Leave
            </button>
            {onLeaveEmps.length>0&&(session.role==='employee'?onLeaveEmps.find(e=>e.empId===session.empId):true)&&(
              <button className="fp-btn" style={{...S.btn,background:'linear-gradient(135deg,#6c63ff,#a78bfa)',color:'#fff',opacity:selRoom?1:0.5}} onClick={()=>{if(!selRoom)return showToast('Select a showroom first.','error');setReturnM(true)}}>🔙 Return from Leave</button>
            )}
          </div>
          <div className="card-pad" style={S.card}>
            <h3 style={S.cardH}>Today's Log</h3>
            <div style={S.logBox}>
              {log.length===0
                ?<div style={{color:'#94a3b8',fontSize:'0.78rem',textAlign:'center',padding:'20px 0'}}>No activity yet</div>
                :log.map(r=>(
                  <div key={r.id} style={S.logRow}>
                    <div style={{width:6,height:6,borderRadius:'50%',background:logColors[r.type]||'#64748b',flexShrink:0,marginTop:5}}/>
                    <span style={{color:'#94a3b8',fontSize:'0.7rem',whiteSpace:'nowrap'}}>{r.time}</span>
                    <span style={{fontSize:'0.74rem',color:'#374151'}}>{r.empName?.split(' ')[0]} · {typeLabel[r.type]}{r.duration?` (${r.duration}m)`:''}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>}

      {tab==='report'&&canViewReports(session)&&<div className="page-content" style={S.page}>
        <div className="page-h1" style={S.h1}>Reports</div>
        <div style={S.sub}>{session.role==='manager'?`${dn(session.showroom)} only`:'All showrooms'}</div>
        <div className="filters-row" style={S.filters}>
          {session.role==='admin'&&(
            <select style={{...S.sel,width:'auto',minWidth:130}} value={fRoom} onChange={e=>setFRoom(e.target.value)}>
              <option value="">All Showrooms</option>
              {SHOWROOMS.map(s=><option key={s} value={s}>{dnShort(s)}</option>)}
            </select>
          )}
          <select style={{...S.sel,width:'auto',minWidth:130}} value={fEmp} onChange={e=>setFEmp(e.target.value)}>
            <option value="">All Employees</option>
            {employees.map(e=><option key={e.id} value={e.empId}>{e.name}</option>)}
          </select>
          <input type="date" style={{...S.sel,width:'auto',minWidth:140}} value={fDate} onChange={e=>setFDate(e.target.value)}/>
          <select style={{...S.sel,width:'auto',minWidth:120}} value={fType} onChange={e=>setFType(e.target.value)}>
            <option value="">All Types</option>
            <option value="arrive">Arrive</option>
            <option value="depart">Depart</option>
            <option value="leave">Leave</option>
            <option value="return">Return</option>
          </select>
          <button style={S.exportBtn} onClick={exportExcel}>⬇ Excel</button>
        </div>
        <div className="stats-grid" style={S.statsGrid}>
          {[{l:'Total',v:allRecs.length,c:'#1a6fe8'},{l:'Arrived',v:stats.arrived??0,c:'#16a34a'},{l:'Departed',v:stats.departed??0,c:'#dc2626'},{l:'Leaves',v:stats.onLeave??0,c:'#d97706'}].map(s=>(
            <div key={s.l} style={S.statCard}>
              <div style={{fontSize:'0.68rem',color:'#64748b',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:4}}>{s.l}</div>
              <div style={{fontSize:'1.8rem',fontWeight:800,color:s.c}}>{s.v}</div>
            </div>
          ))}
        </div>
        <div className="table-scroll">
          {loading?<div style={{textAlign:'center',padding:32,color:'#64748b'}}>Loading…</div>
            :<table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.78rem',minWidth:600}}>
              <thead><tr style={{borderBottom:'2px solid #e2e8f0'}}>
                {['Employee','Showroom','Type','Arrive','Depart','Work Hrs','OT/Short','Date','Reason'].map(h=>(
                  <th key={h} style={{textAlign:'left',padding:'8px 10px',color:'#64748b',fontWeight:600,fontSize:'0.7rem',textTransform:'uppercase',letterSpacing:'.05em',whiteSpace:'nowrap'}}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {allRecs.length===0
                  ?<tr><td colSpan={9} style={{textAlign:'center',color:'#64748b',padding:32}}>No records found</td></tr>
                  :(() => {
                    // Group by employee+date for arrive/depart pairing
                    const grouped2={}
                    allRecs.forEach(r=>{
                      const k=`${r.empId}||${r.date}`
                      if(!grouped2[k]) grouped2[k]={empName:r.empName,showroom:r.showroom,date:r.date,arrive:null,depart:null,leaves:[],others:[]}
                      if(r.type==='arrive') grouped2[k].arrive=r
                      else if(r.type==='depart') grouped2[k].depart=r
                      else if(r.type==='leave') grouped2[k].leaves.push(r)
                      else grouped2[k].others.push(r)
                    })
                    return Object.values(grouped2).sort((a,b)=>b.date?.localeCompare(a.date)||a.empName?.localeCompare(b.empName)).map((g,gi)=>{
                      const emp=employees.find(e=>e.empId===g.arrive?.empId||e.empId===g.depart?.empId)
                      const[shStart,shEnd]=[getShift(g.showroom,emp?.staffType).start,getShift(g.showroom,emp?.staffType).end]
                      const toMin2=t=>{if(!t)return null;const p=t.split(':');return parseInt(p[0])*60+parseInt(p[1])}
                      const aMin=toMin2(g.arrive?.time),dMin=toMin2(g.depart?.time)
                      const sMin=toMin2(shStart),eMin=toMin2(shEnd)
                      const leaveDurTotal=g.leaves.reduce((a,r)=>a+(parseInt(r.duration)||0),0)
                      const workMin=aMin&&dMin?Math.max(0,dMin-aMin-leaveDurTotal):null
                      const targetMin=sMin&&eMin?eMin-sMin:null
                      const otMin=workMin!=null&&targetMin?workMin-targetMin:null
                      const fmtH2=m=>{if(m==null)return'—';if(m<=0)return'0h 0m';return`${Math.floor(m/60)}h ${m%60}m`}
                      return(
                        <tr key={gi} style={{borderBottom:'1px solid #f1f5f9',background:gi%2===0?'#fff':'#f8fafc'}}>
                          <td style={{padding:'9px 10px',fontWeight:500,color:'#0f172a',whiteSpace:'nowrap'}}>{g.empName?.split(' ')[0]}</td>
                          <td style={{padding:'9px 10px',color:'#64748b',fontSize:'0.7rem',whiteSpace:'nowrap'}}>{dnShort(g.showroom)}</td>
                          <td style={{padding:'9px 10px'}}>
                            {g.arrive&&<span style={badge('arrive')}>Arrive</span>}
                            {g.depart&&<span style={{...badge('depart'),marginLeft:4}}>Depart</span>}
                            {g.leaves.length>0&&<span style={{...badge('leave'),marginLeft:4}}>Leave</span>}
                          </td>
                          <td style={{padding:'9px 10px',color:aMin&&sMin&&aMin>sMin?'#d97706':'#16a34a',fontWeight:500,whiteSpace:'nowrap'}}>{g.arrive?.time||'—'}</td>
                          <td style={{padding:'9px 10px',color:dMin&&eMin&&dMin<eMin?'#dc2626':'#0f172a',whiteSpace:'nowrap'}}>{g.depart?.time||<span style={{color:'#f59e0b',fontSize:'0.72rem'}}>No departure</span>}</td>
                          <td style={{padding:'9px 10px',fontWeight:600,color:workMin?'#0f172a':'#94a3b8'}}>{fmtH2(workMin)}</td>
                          <td style={{padding:'9px 10px'}}>
                            {otMin!=null
                              ?<span style={{fontSize:'0.72rem',fontWeight:600,color:otMin>0?'#7c3aed':otMin<0?'#dc2626':'#16a34a',background:otMin>0?'#ede9fe':otMin<0?'#fee2e2':'#dcfce7',padding:'2px 8px',borderRadius:20}}>
                                {otMin>0?'+':''}{fmtH2(otMin)}
                              </span>
                              :'—'}
                          </td>
                          <td style={{padding:'9px 10px',color:'#64748b',whiteSpace:'nowrap'}}>{g.date}</td>
                          <td style={{padding:'9px 10px',color:'#64748b',fontSize:'0.72rem',maxWidth:120,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{g.leaves.map(l=>l.reason).filter(Boolean).join(', ')||'—'}</td>
                        </tr>
                      )
                    })
                  })()
                }
              </tbody>
            </table>}
        </div>
      </div>}

      {tab==='admin'&&canManageEmployees(session)&&<div className="page-content" style={S.page}>
        <div className="page-h1" style={S.h1}>Admin Panel</div>
        <div style={S.sub}>Manage employees, roles and PINs</div>
        <div className="admin-grid" style={S.grid2}>
          <div className="card-pad" style={S.card}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
              <h3 style={{...S.cardH,marginBottom:0}}>👥 Employees ({employees.filter(e=>{const ms=!empSearch||e.name.toLowerCase().includes(empSearch.toLowerCase())||e.empId.toLowerCase().includes(empSearch.toLowerCase());const mf=empFilter==='all'||e.showroom===empFilter;return ms&&mf}).length} / {employees.length})</h3>
            </div>
            <input placeholder="🔍 Search name or ID..." value={empSearch} onChange={e=>setEmpSearch(e.target.value)} style={{width:'100%',padding:'9px 12px',background:'#f8fafc',border:'1.5px solid #e2e8f0',borderRadius:8,fontSize:'14px',marginBottom:10,outline:'none',fontFamily:"'Inter',sans-serif",color:'#0f172a'}}/>
            <div style={{display:'flex',gap:6,marginBottom:10,flexWrap:'wrap'}}>
              {['All',...SHOWROOMS.map(s=>dnShort(s))].map((f,i)=>(
                <button key={f} onClick={()=>setEmpFilter(i===0?'all':SHOWROOMS[i-1])}
                  style={{padding:'4px 12px',borderRadius:20,border:'1px solid',fontSize:'0.72rem',cursor:'pointer',fontFamily:"'Inter',sans-serif",fontWeight:500,borderColor:empFilter===(i===0?'all':SHOWROOMS[i-1])?'#1a6fe8':'#e2e8f0',background:empFilter===(i===0?'all':SHOWROOMS[i-1])?'#e8f1fd':'#fff',color:empFilter===(i===0?'all':SHOWROOMS[i-1])?'#1a6fe8':'#64748b'}}>
                  {f}
                </button>
              ))}
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {employees.filter(e=>{const ms=!empSearch||e.name.toLowerCase().includes(empSearch.toLowerCase())||e.empId.toLowerCase().includes(empSearch.toLowerCase());const mf=empFilter==='all'||e.showroom===empFilter;return ms&&mf}).map(e=>{
                const recs=todayRecs.filter(r=>r.empId===e.empId)
                const last=[...recs].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0]
                const sm={arrive:['Present','#16a34a'],depart:['Departed','#dc2626'],leave:['On Leave','#d97706'],return:['Returned','#7c3aed']}
                const[lbl,clr]=(last&&sm[last.type])||['Not in','#94a3b8']
                const isEditing=editPinId===e.id
                return(
                  <div key={e.id} style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',boxShadow:'0 1px 3px rgba(0,0,0,0.04)'}}>
                    <div style={{display:'flex',alignItems:'center',gap:10,padding:'12px 14px'}}>
                      <div style={{width:38,height:38,borderRadius:'50%',background:e.color+'22',color:e.color,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:'0.82rem',flexShrink:0}}>{initials(e.name)}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:'0.85rem',fontWeight:600,color:'#0f172a',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{e.name}</div>
                        <div style={{fontSize:'0.7rem',color:'#64748b'}}>{e.empId} · {dnShort(e.showroom)} · <span style={{color:roleColor[e.role]||'#64748b',fontWeight:500}}>{ROLE_LABELS[e.role]||e.role}</span></div>
                      </div>
                      <span style={{fontSize:'0.68rem',color:clr,background:clr+'22',padding:'3px 8px',borderRadius:20,whiteSpace:'nowrap',flexShrink:0,fontWeight:500}}>{lbl}</span>
                    </div>
                    <div style={{display:'flex',flexDirection:'row',borderTop:'1px solid #f1f5f9',width:'100%'}}>
                      <button onClick={()=>{setEditPinId(isEditing?null:e.id);setEditPinVal('')}} style={{flex:1,padding:'10px 8px',background:isEditing?'#fef3c7':'#f8fafc',border:'none',borderRight:'1px solid #e2e8f0',color:isEditing?'#92400e':'#1456b8',fontSize:'0.78rem',cursor:'pointer',fontWeight:600,fontFamily:"'Inter',sans-serif",textAlign:'center'}}>
                        🔑 {isEditing?'Cancel':'Change PIN'}
                      </button>
                      <button onClick={()=>{if(window.confirm('Delete '+e.name+'? This cannot be undone.'))removeEmployee(e.id,e.name)}} style={{flex:1,padding:'10px 8px',background:'#fff5f5',border:'none',color:'#dc2626',fontSize:'0.78rem',cursor:'pointer',fontWeight:600,fontFamily:"'Inter',sans-serif",textAlign:'center'}}>
                        🗑️ Delete
                      </button>
                    </div>
                    {isEditing&&(
                      <div style={{padding:'10px 14px',background:'#fffbeb',borderTop:'1px solid #fde68a',display:'flex',gap:8,alignItems:'center'}}>
                        <input type="password" inputMode="numeric" placeholder="New PIN (4–6 digits)" value={editPinVal} onChange={e=>setEditPinVal(e.target.value.replace(/\D/g,'').slice(0,6))} maxLength={6} style={{flex:1,padding:'8px 12px',background:'#fff',border:'1.5px solid #fde68a',borderRadius:8,color:'#0f172a',fontFamily:"'Inter',sans-serif",fontSize:'14px',outline:'none'}}/>
                        <button onClick={()=>savePinEdit(e.id)} style={{padding:'8px 16px',background:'#1a6fe8',border:'none',borderRadius:8,color:'#fff',fontSize:'0.78rem',cursor:'pointer',fontWeight:700,fontFamily:"'Inter',sans-serif",whiteSpace:'nowrap'}}>✓ Save</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="card-pad" style={S.card}>
            <h3 style={S.cardH}>➕ Add Employee</h3>
            <div style={{display:'flex',flexDirection:'column',gap:12}}>
              {[['Full Name',newName,setNewName,'e.g. Mohammed Ali','text'],['Employee ID',newId,setNewId,'e.g. EMP-008','text']].map(([lbl,val,set,ph,type])=>(
                <div key={lbl}><div style={S.inputLabel}>{lbl}</div><input type={type} placeholder={ph} value={val} onChange={e=>set(e.target.value)} style={S.adminInput}/></div>
              ))}
              <div><div style={S.inputLabel}>Showroom</div><select value={newRoom} onChange={e=>{setNewRoom(e.target.value);setNewST('showroom')}} style={S.adminInput}>{SHOWROOMS.map(s=><option key={s} value={s}>{dn(s)}</option>)}</select></div>
              <div><div style={S.inputLabel}>Staff Type</div><select value={newST} onChange={e=>setNewST(e.target.value)} style={S.adminInput}><option value="showroom">Showroom Staff</option>{newRoom==='Idealz Prime'&&<option value="backoffice">Back Office</option>}</select></div>
              <div><div style={S.inputLabel}>Role / Access Level</div><select value={newRole} onChange={e=>setNewRole(e.target.value)} style={S.adminInput}><option value="employee">Employee — Check in/out only</option><option value="manager">Manager — See showroom reports</option><option value="admin">Admin / HR — Full access</option></select></div>
              <div><div style={S.inputLabel}>PIN (4–6 digits)</div><input type="password" inputMode="numeric" placeholder="e.g. 1234" value={newPin} onChange={e=>setNewPin(e.target.value.replace(/\D/g,'').slice(0,6))} maxLength={6} style={S.adminInput}/></div>
              <div style={{fontSize:'0.7rem',padding:'8px 12px',background:'#e8f1fd',borderRadius:8,color:'#1456b8'}}>⏰ Shift: {getShift(newRoom,newST).start} – {getShift(newRoom,newST).end}</div>
              <button style={{...S.btn,background:'#1a6fe8',color:'#fff',minHeight:50}} onClick={addEmployee}>➕ Add Employee</button>
            </div>
            <div style={{marginTop:20}}>
              <h3 style={{...S.cardH,marginBottom:10,fontSize:'0.95rem'}}>🔑 Role Access Guide</h3>
              {[{role:'Employee',color:'#64748b',desc:'Check in/out for themselves only'},{role:'Manager',color:'#0369a1',desc:'Reports for their showroom only'},{role:'Admin',color:'#7c3aed',desc:'Full access — all showrooms + admin'}].map(r=>(
                <div key={r.role} style={{display:'flex',gap:10,alignItems:'flex-start',padding:'7px 0',borderBottom:'1px solid #f1f5f9'}}>
                  <span style={{fontSize:'0.7rem',color:r.color,background:r.color+'22',padding:'2px 8px',borderRadius:20,whiteSpace:'nowrap',marginTop:1,flexShrink:0}}>{r.role}</span>
                  <span style={{fontSize:'0.72rem',color:'#64748b'}}>{r.desc}</span>
                </div>
              ))}
            </div>
            <div style={{marginTop:20,padding:16,background:'#fff5f5',border:'1px solid #fca5a5',borderRadius:12}}>
              <h3 style={{fontSize:'0.95rem',marginBottom:8,color:'#dc2626',fontWeight:700}}>🗂️ Archive Old Records</h3>
              <div style={{fontSize:'0.72rem',color:'#64748b',marginBottom:12,lineHeight:1.5}}>Export records to Excel then permanently delete from database.</div>
              <button style={{width:'100%',padding:'10px',background:'#fee2e2',border:'1px solid #fca5a5',borderRadius:8,color:'#dc2626',fontSize:'0.8rem',cursor:'pointer',fontWeight:700}} onClick={openArchiveModal}>📦 Export & Delete Old Records</button>
            </div>
          </div>
        </div>
      </div>}

      {fpOverlay&&<div style={S.fpOv}><div style={S.fpCircle}>👤</div><div style={{fontSize:'1.1rem',fontWeight:700,textAlign:'center',padding:'0 20px',color:'#fff'}}>{fpLabel}</div><div style={{fontSize:'0.78rem',color:'rgba(255,255,255,0.7)'}}>Use Face ID or fingerprint sensor</div></div>}

      {leaveModal&&(
        <div style={S.modalBg} onClick={e=>e.target===e.currentTarget&&setLeaveM(false)}>
          <div className="modal-box" style={S.modal}>
            <h3 style={{fontSize:'1.1rem',fontWeight:700,marginBottom:16,color:'#0f172a'}}>🕐 Short Leave Request</h3>
            {session.role!=='employee'&&<div style={{marginBottom:12}}><div style={S.inputLabel}>Employee</div><select value={leaveEmp} onChange={e=>setLeaveEmp(e.target.value)} style={S.adminInput}><option value="">— Select —</option>{empForRoom.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></div>}
            <div style={{marginBottom:12}}><div style={S.inputLabel}>Duration</div><select value={leaveDur} onChange={e=>setLeaveDur(e.target.value)} style={S.adminInput}>{[['15','15 min'],['30','30 min'],['45','45 min'],['60','1 hour'],['90','1.5 hrs'],['120','2 hours']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
            <div style={{marginBottom:16}}><div style={S.inputLabel}>Reason</div><textarea placeholder="Brief reason…" value={leaveReason} onChange={e=>setLeaveR(e.target.value)} style={{...S.adminInput,resize:'vertical',minHeight:64}}/></div>
            <div style={{display:'flex',gap:10}}>
              <button style={{padding:'12px 16px',background:'transparent',color:'#64748b',border:'1px solid #e2e8f0',borderRadius:8,cursor:'pointer'}} onClick={()=>setLeaveM(false)}>Cancel</button>
              <button style={{...S.btn,flex:1,background:'#1a6fe8',color:'#fff',padding:12}} onClick={submitLeave}>👤 Face ID & Submit</button>
            </div>
          </div>
        </div>
      )}

      {returnModal&&(
        <div style={S.modalBg} onClick={e=>e.target===e.currentTarget&&setReturnM(false)}>
          <div className="modal-box" style={S.modal}>
            <h3 style={{fontSize:'1.1rem',fontWeight:700,marginBottom:6,color:'#0f172a'}}>🔙 Return from Leave</h3>
            <div style={{fontSize:'0.74rem',color:'#64748b',marginBottom:16}}>Confirm you are back at the showroom</div>
            {onLeaveEmps.filter(e=>!selRoom||e.showroom===selRoom).length>0&&(
              <div style={{marginBottom:16,borderRadius:10,overflow:'hidden',border:'1px solid #e2e8f0'}}>
                {onLeaveEmps.filter(e=>!selRoom||e.showroom===selRoom).map(e=>(
                  <div key={e.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',background:e.overdue?'#fff5f5':'#f8fafc',borderBottom:'1px solid #f1f5f9'}}>
                    <div style={{width:30,height:30,borderRadius:'50%',background:e.color+'22',color:e.color,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:'0.72rem',flexShrink:0}}>{initials(e.name)}</div>
                    <div style={{flex:1}}><div style={{fontSize:'0.8rem',fontWeight:500,color:'#0f172a'}}>{e.name}</div><div style={{fontSize:'0.68rem',color:'#64748b'}}>Out for {e.minutesGone} min · Expected {e.expectedDur} min</div></div>
                    {e.overdue&&<span style={{fontSize:'0.68rem',color:'#dc2626',background:'#fee2e2',padding:'2px 8px',borderRadius:20,flexShrink:0}}>⚠️ {e.overdueBy}m late</span>}
                  </div>
                ))}
              </div>
            )}
            {session.role!=='employee'&&<div style={{marginBottom:12}}><div style={S.inputLabel}>Select Employee</div><select value={returnEmp} onChange={e=>setReturnEmp(e.target.value)} style={S.adminInput}><option value="">— Select —</option>{onLeaveEmps.filter(e=>!selRoom||e.showroom===selRoom).map(e=><option key={e.id} value={e.id}>{e.name}{e.overdue?` (⚠️ ${e.overdueBy}m overdue)`:''}</option>)}</select></div>}
            <div style={{padding:'10px 14px',background:'#e8f1fd',borderRadius:8,fontSize:'0.76rem',color:'#1456b8',marginBottom:16}}>👤 Face ID will verify your identity when you return</div>
            <div style={{display:'flex',gap:10}}>
              <button style={{padding:'12px 16px',background:'transparent',color:'#64748b',border:'1px solid #e2e8f0',borderRadius:8,cursor:'pointer'}} onClick={()=>setReturnM(false)}>Cancel</button>
              <button style={{...S.btn,flex:1,background:'linear-gradient(135deg,#6c63ff,#a78bfa)',color:'#fff',padding:12}} onClick={submitReturn}>👤 Face ID — I'm Back</button>
            </div>
          </div>
        </div>
      )}

      {archiveModal&&(
        <div style={S.modalBg} onClick={e=>e.target===e.currentTarget&&setArchiveM(false)}>
          <div className="modal-box" style={S.modal}>
            <h3 style={{fontSize:'1.1rem',fontWeight:700,marginBottom:6,color:'#dc2626'}}>🗂️ Export & Delete Old Records</h3>
            <div style={{fontSize:'0.74rem',color:'#64748b',marginBottom:20,lineHeight:1.6}}>This will <strong style={{color:'#0f172a'}}>first download an Excel backup</strong>, then permanently delete the selected records from Firebase.</div>
            <div style={{marginBottom:16}}><div style={S.inputLabel}>Delete records older than</div><select value={archivePeriod} onChange={e=>handleArchivePeriodChange(e.target.value)} style={S.adminInput}><option value="1">1 month</option><option value="2">2 months</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">1 year</option></select></div>
            <div style={{padding:'14px 16px',background:'#f8fafc',borderRadius:10,border:'1px solid #e2e8f0',marginBottom:20,textAlign:'center'}}>
              {archiveLoading?<div style={{fontSize:'0.82rem',color:'#64748b'}}>Counting records…</div>:archiveCount===0?<div style={{fontSize:'0.82rem',color:'#16a34a'}}>✅ No records found older than {archivePeriod} month(s)</div>:<><div style={{fontSize:'2rem',fontWeight:800,color:'#dc2626'}}>{archiveCount}</div><div style={{fontSize:'0.76rem',color:'#64748b',marginTop:4}}>records will be exported & deleted</div></>}
            </div>
            {archiveCount>0&&<div style={{padding:'10px 14px',background:'#fff5f5',border:'1px solid #fca5a5',borderRadius:8,fontSize:'0.74rem',color:'#dc2626',marginBottom:16,lineHeight:1.5}}>⚠️ Excel file will download automatically first. Save it before confirming deletion.</div>}
            <div style={{display:'flex',gap:10}}>
              <button style={{padding:'12px 16px',background:'transparent',color:'#64748b',border:'1px solid #e2e8f0',borderRadius:8,cursor:'pointer'}} onClick={()=>setArchiveM(false)}>Cancel</button>
              <button style={{...S.btn,flex:1,background:archiveCount>0?'#dc2626':'#e2e8f0',color:'#fff',padding:12,opacity:archiveLoading||archiveCount===0?0.5:1}} onClick={exportAndDeleteOldRecords} disabled={archiveLoading||archiveCount===0}>{archiveLoading?'Processing…':`⬇ Export & Delete ${archiveCount} Records`}</button>
            </div>
          </div>
        </div>
      )}

      {toast&&<div style={{...S.toast,borderColor:toast.type==='error'?'#fca5a5':toast.type==='info'?'#93c5fd':'#86efac'}}>{toast.msg}</div>}

      <div className="bottom-nav">
        <div className="bottom-nav-inner">
          <button className={`bnav-btn${tab==='checkin'?' on':''}`} onClick={()=>setTab('checkin')}><span className="bnav-icon">👤</span><span>Check In</span></button>
          {canViewReports(session)&&<button className={`bnav-btn${tab==='report'?' on':''}`} onClick={()=>setTab('report')}><span className="bnav-icon">📊</span><span>Reports</span></button>}
          {canManageEmployees(session)&&<button className={`bnav-btn${tab==='admin'?' on':''}`} onClick={()=>setTab('admin')}><span className="bnav-icon">👥</span><span>Admin</span></button>}
          {canViewAnalytics(session)&&<a href="/analytics" className="bnav-btn"><span className="bnav-icon">📈</span><span>Analytics</span></a>}
          <button className="bnav-btn" onClick={logout} style={{color:'#ef4444'}}><span className="bnav-icon">🚪</span><span>Sign out</span></button>
        </div>
      </div>
    </div>
  </>)
}

function badge(type,overdue=false){
  if(type==='return'&&overdue) return {display:'inline-block',padding:'3px 10px',borderRadius:20,fontSize:'0.72rem',fontWeight:500,background:'#fee2e2',color:'#dc2626',whiteSpace:'nowrap'}
  const m={arrive:['#dcfce7','#16a34a'],depart:['#fee2e2','#dc2626'],leave:['#fef3c7','#d97706'],return:['#ede9fe','#7c3aed']}
  const[bg,color]=m[type]||['#f1f5f9','#64748b']
  return {display:'inline-block',padding:'3px 10px',borderRadius:20,fontSize:'0.72rem',fontWeight:500,background:bg,color,whiteSpace:'nowrap'}
}

const S={
  nav:{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 24px',height:64,borderBottom:'1px solid #e2e8f0',background:'#fff',position:'sticky',top:0,zIndex:100,fontFamily:"'Inter',sans-serif",gap:12,boxShadow:'0 1px 8px rgba(0,0,0,0.06)'},
  brand:{fontFamily:"'Inter',sans-serif",fontSize:'1rem',fontWeight:800,display:'flex',alignItems:'center',gap:10,flexShrink:0},
  tabs:{display:'flex',gap:4,background:'#f1f5f9',padding:3,borderRadius:10,border:'1px solid #e2e8f0'},
  tab:{padding:'6px 14px',borderRadius:7,fontFamily:"'Inter',sans-serif",fontSize:'0.76rem',fontWeight:500,cursor:'pointer',border:'none',background:'transparent',color:'#64748b'},
  tabOn:{background:'#1a6fe8',color:'#fff',boxShadow:'0 2px 8px rgba(26,111,232,0.3)'},
  page:{position:'relative',zIndex:1,padding:'24px 24px 100px',maxWidth:1100,margin:'0 auto'},
  h1:{fontFamily:"'Inter',sans-serif",fontSize:'1.5rem',fontWeight:800,marginBottom:6,color:'#0f172a'},
  sub:{fontSize:'0.78rem',color:'#64748b',marginBottom:24},
  roomGrid:{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14,marginBottom:24},
  roomCard:{background:'#fff',border:'2px solid #e2e8f0',borderRadius:16,overflow:'hidden',cursor:'pointer',transition:'all .2s',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'},
  roomOn:{borderColor:'#1a6fe8',boxShadow:'0 4px 20px rgba(26,111,232,0.2)'},
  grid2:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16},
  card:{background:'#fff',border:'1px solid #e2e8f0',borderRadius:16,padding:22,boxShadow:'0 1px 4px rgba(0,0,0,0.04)'},
  cardH:{fontFamily:"'Inter',sans-serif",fontSize:'1rem',fontWeight:700,marginBottom:16,color:'#0f172a'},
  sel:{width:'100%',padding:'11px 14px',background:'#fff',border:'1.5px solid #e2e8f0',borderRadius:10,color:'#0f172a',fontFamily:"'Inter',sans-serif",fontSize:'16px',marginBottom:12,cursor:'pointer',outline:'none'},
  btn:{width:'100%',padding:14,borderRadius:12,border:'none',fontFamily:"'Inter',sans-serif",fontWeight:700,fontSize:'0.95rem',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,transition:'all .2s'},
  logBox:{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:10,padding:12,maxHeight:200,overflowY:'auto'},
  logRow:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',borderBottom:'1px solid #f1f5f9',fontSize:'0.75rem'},
  filters:{display:'flex',gap:10,marginBottom:20,flexWrap:'wrap',alignItems:'center'},
  exportBtn:{padding:'10px 16px',background:'#1a6fe8',color:'#fff',border:'none',borderRadius:8,fontFamily:"'Inter',sans-serif",fontWeight:600,cursor:'pointer',fontSize:'0.82rem',whiteSpace:'nowrap'},
  statsGrid:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:20},
  statCard:{background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,padding:16,boxShadow:'0 1px 4px rgba(0,0,0,0.04)'},
  fpOv:{position:'fixed',inset:0,background:'rgba(15,23,42,0.85)',zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:20,backdropFilter:'blur(4px)'},
  fpCircle:{width:110,height:110,borderRadius:'50%',border:'3px solid #1a6fe8',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'3rem',background:'#e8f1fd'},
  modalBg:{position:'fixed',inset:0,background:'rgba(15,23,42,0.6)',backdropFilter:'blur(4px)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16},
  modal:{background:'#fff',border:'1px solid #e2e8f0',borderRadius:20,padding:24,width:420,maxWidth:'100%',boxShadow:'0 20px 60px rgba(0,0,0,0.15)'},
  toast:{position:'fixed',bottom:80,right:16,zIndex:999,background:'#fff',border:'1px solid',borderRadius:12,padding:'12px 18px',fontSize:'0.82rem',maxWidth:'calc(100vw - 32px)',fontFamily:"'Inter',sans-serif",boxShadow:'0 4px 20px rgba(0,0,0,0.12)'},
  warnBox:{fontSize:'0.78rem',color:'#d97706',marginBottom:12,padding:'8px 12px',background:'#fef3c7',borderRadius:8,border:'1px solid #fde68a'},
  inputLabel:{fontSize:'0.75rem',fontWeight:600,color:'#374151',marginBottom:5},
  adminInput:{background:'#fff',border:'1.5px solid #e2e8f0',borderRadius:10,color:'#0f172a',fontFamily:"'Inter',sans-serif",fontSize:'16px',padding:'11px 14px',width:'100%',outline:'none'},
}
