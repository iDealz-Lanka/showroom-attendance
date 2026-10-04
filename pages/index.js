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

// Closest branch regardless of radius, so the page can say how far away they
// are instead of staying silent until they tap and get rejected.
function nearestBranch(lat, lng) {
  let best = null, bestDist = Infinity
  for (const name of Object.keys(SHOWROOM_LOCATIONS)) {
    const loc = SHOWROOM_LOCATIONS[name]
    const d = getDistance(loc.lat, loc.lng, lat, lng)
    if (d < bestDist) { best = name; bestDist = d }
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

/* ── Attendance maths ──────────────────────────────────────────────────────
   One place for lateness, hours and branch-cover logic, so the on-screen
   report and the Excel export can never disagree. Mirrors analytics.js. */

// Seconds past shift start before an arrival counts as late.
// Keep this the same as GRACE_SEC in analytics.js.
const GRACE_SEC = 60
// Roles that attendance applies to. Admin/HR is left out so it does not
// appear as absent every single day.
const ATT_ROLES = ['employee','manager','backoffice']

// Records store HH:MM:SS, shifts store HH:MM. Seconds matter: without them
// an arrival at 09:45:59 reads as exactly on time.
function toSec(t){ if(!t||t==='—')return null; const p=t.split(':').map(Number); return p[0]*3600+p[1]*60+(p[2]||0) }
function fmtH(m){ if(m==null)return'—'; const n=Math.abs(Math.round(m)); return `${Math.floor(n/60)}h ${n%60}m` }
// "45s" under a minute, "14m" above it
function fmtGap(sec){ if(!sec||sec<=0)return'—'; return sec<60?`${sec}s`:`${Math.round(sec/60)}m` }

/* One row per employee per working day, absences included.
   `room` = '' for all branches.

   Branch filtering happens HERE, per date, not on the records beforehand.
   A cover day is stored against the branch worked, so filtering records
   first would hide it and the person would read as absent at home. */
function buildDayRows(records, employees, room, empId) {
  // The roster is what generates rows, so the employee filter has to be applied
  // HERE. Filtering only the records leaves everyone else on the roster with a
  // row a day and no records to fill it, which reads as absent.
  const roster = employees
    .filter(e => ATT_ROLES.includes(e.role||'employee'))
    .filter(e => !empId || e.empId === empId)
  // A date counts as a working day only if something was recorded that day.
  // Walking the calendar instead would mark Poya days, Sundays and closures
  // as absence for all 30 staff.
  // Every date the business recorded anything, for ALL staff — not just the
  // filtered person. Otherwise their absent days have no date to appear on.
  const dates = [...new Set(records.map(r=>r.date).filter(Boolean))].sort()
  const rows = []

  dates.forEach(date => {
    const dayRecs = records.filter(r => r.date === date)
    roster.forEach(emp => {
      const recs   = dayRecs.filter(r => r.empId === emp.empId)
      const arr    = recs.filter(r=>r.type==='arrive').sort((a,b)=>(a.time||'').localeCompare(b.time||''))[0]
      const dep    = recs.filter(r=>r.type==='depart').sort((a,b)=>(b.time||'').localeCompare(a.time||''))[0]
      const leaves = recs.filter(r=>r.type==='leave')

      const home = emp.showroom || ''
      // The day belongs to the branch they clocked IN at. Older records have
      // no homeShowroom field, so the employee's own branch is the fallback.
      const workedAt   = arr?.showroom || dep?.showroom || home
      const departedAt = dep?.showroom || null
      // Worked somewhere that is not their own branch
      const covering   = !!(arr||dep) && workedAt !== home
      // Clocked in at one branch and out at another, same day
      const moved      = !!(arr && dep && arr.showroom !== dep.showroom)

      if (room && workedAt !== room) return

      // Shift follows the branch actually worked, so cover at Prime is judged
      // against Prime's 09:45 and not the home branch's 10:00.
      const shift = getShift(workedAt, emp.staffType||'showroom')
      const sSec = toSec(shift.start), eSec = toSec(shift.end)
      const aSec = arr ? toSec(arr.time) : null
      const dSec = dep ? toSec(dep.time) : null

      const lateSec  = aSec!=null && aSec>sSec ? aSec-sSec : 0
      const earlySec = dSec!=null && dSec<eSec ? eSec-dSec : 0
      const leaveMin = leaves.reduce((a,r)=>a+(parseInt(r.duration)||0),0)
      const leaveRsn = leaves.map(r=>r.reason).filter(Boolean).join('; ')

      const targetMin = Math.round((eSec-sSec)/60)
      // Departure earlier than arrival means the pair is broken — usually a
      // past-midnight checkout filed under the previous date.
      const broken  = aSec!=null && dSec!=null && dSec < aSec
      const workMin = (aSec!=null && dSec!=null && !broken)
        ? Math.max(0, Math.round((dSec-aSec)/60) - leaveMin) : null
      const otMin   = workMin!=null ? workMin-targetMin : null

      const status = !arr                      ? 'Absent'
                   : broken                    ? 'Check Records'
                   : workMin==null             ? 'No Departure'
                   : workMin < targetMin/2     ? 'Half Day'
                   : lateSec > GRACE_SEC       ? 'Late'
                   :                             'Present'

      rows.push({
        empId: emp.empId,
        Employee: emp.name,
        'Emp ID': emp.empId,
        'Home Branch': dnShort(home),
        'Worked At': arr||dep ? dnShort(workedAt) : '—',
        'Left From': moved ? dnShort(departedAt) : '',
        Cover: covering ? (moved ? 'Cover + moved' : 'Cover') : (moved ? 'Moved' : ''),
        Date: date,
        Day: new Date(date+'T00:00:00').toLocaleDateString('en-GB',{weekday:'short'}),
        Status: status,
        'Arrive Time': arr?.time || '—',
        'Depart Time': dep?.time || '—',
        'Shift Start': shift.start,
        'Shift End': shift.end,
        'Late By': fmtGap(lateSec),
        'Early Exit': fmtGap(earlySec),
        'Short Leave': leaveMin>0 ? `${leaveMin}m` : '—',
        'Leave Reason': leaveRsn || '—',
        'Work Hours': workMin!=null ? fmtH(workMin) : (arr ? 'No departure' : '—'),
        'Target Hours': fmtH(targetMin),
        'OT / Short': otMin!=null ? (otMin>=0?'+':'-')+fmtH(otMin) : '—',
        'OT Flag': otMin==null ? '—' : otMin>0 ? 'OT' : otMin<0 ? 'Short' : 'On Time',
        // Late is tracked separately from Status, because Status can only hold
        // one value and 'No Departure' would otherwise hide the late arrival.
        _isLate: lateSec > GRACE_SEC,
        // Branch key the app does not know — usually a typo in Firestore
        _badBranch: !!(workedAt && !SHOWROOMS.includes(workedAt)),
        _lateSec: lateSec, _earlySec: earlySec, _otMin: otMin, _workMin: workMin,
        _covering: covering, _moved: moved, _broken: broken,
        _workedAt: workedAt, _home: home, _departedAt: departedAt,
      })
    })
  })
  return rows.sort((a,b)=> b.Date.localeCompare(a.Date) || a.Employee.localeCompare(b.Employee))
}

// Headline counts for the Reports page, from the same rows Excel uses
function dayRowKPIs(rows) {
  const n = s => rows.filter(r=>r.Status===s).length
  return {
    days: rows.length,
    present: rows.filter(r=>r.Status!=='Absent').length,
    absent: n('Absent'),
    late: rows.filter(r=>r._isLate).length,
    halfDay: n('Half Day'),
    noDepart: n('No Departure'),
    broken: n('Check Records'),
    cover: rows.filter(r=>r._covering).length,
    moved: rows.filter(r=>r._moved).length,
    badBranch: rows.filter(r=>r._badBranch).length,
  }
}

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
  const [fFrom, setFFrom]       = useState(today())
  const [fTo, setFTo]           = useState(today())
  const [fType, setFType]       = useState('')
  const [rptView, setRptView]   = useState('summary') // summary = day rows, records = raw taps
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
  const [awayFrom, setAwayFrom] = useState(null) // {room,distance} when not at any branch

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
  // Employees do not pick a branch — GPS says where they are.
  // Returns a cancel function so the effect and the Check again button
  // can share one implementation.
  function detectBranch() {
    if(!session || session.role!=='employee') return ()=>{}
    let cancelled=false
    setDetecting(true); setDetectFailed(false)
    getCurrentPosition()
      .then(pos=>{
        if(cancelled) return
        const found=findBranchAt(pos.lat,pos.lng)
        if(found){
          setSelRoom(found.room); setAwayFrom(null)
        } else {
          // Not inside any branch. Fall back to their own so the shift times
          // and the card still make sense, and record how far off they are so
          // the page can say so before they tap anything.
          setSelRoom(session.showroom)
          setAwayFrom(nearestBranch(pos.lat,pos.lng))
        }
      })
      .catch(()=>{ if(!cancelled){ setSelRoom(session.showroom); setAwayFrom(null); setDetectFailed(true) } })
      .then(()=>{ if(!cancelled) setDetecting(false) })
    return ()=>{ cancelled=true }
  }

  useEffect(()=>detectBranch(),[session])

  useEffect(()=>{
    const t=setInterval(()=>{
      const n=new Date()
      setClock(n.toLocaleTimeString('en-GB'))
      setClkDate(n.toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric'}))
    },1000); return()=>clearInterval(t)
  },[])

  useEffect(()=>{ if(!session) return; loadAll() },[session])
  useEffect(()=>{ if(session&&tab==='report') loadReports() },[tab,fFrom,fTo])

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

  // Local calendar day as YYYY-MM-DD. Not toISOString(), which is UTC and
  // would hand back yesterday's date before 5:30 AM in Sri Lanka.
  function isoDay(d){
    const z=n=>String(n).padStart(2,'0')
    return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`
  }
  // Quick ranges. 'week' is Monday-to-today, 'month' is the 1st to today.
  function applyPreset(k){
    const now=new Date(), t=isoDay(now)
    const back=n=>{const d=new Date(now); d.setDate(d.getDate()-n); return isoDay(d)}
    if(k==='today')     { setFFrom(t); setFTo(t) }
    if(k==='yesterday') { const y=back(1); setFFrom(y); setFTo(y) }
    if(k==='week')      { const dow=(now.getDay()+6)%7; setFFrom(back(dow)); setFTo(t) }
    if(k==='month')     { setFFrom(`${isoDay(now).slice(0,7)}-01`); setFTo(t) }
    if(k==='last30')    { setFFrom(back(29)); setFTo(t) }
    if(k==='all')       { setFFrom(''); setFTo('') }
  }

  async function loadReports() {
    setLoading(true)
    try {
      const snap=await getDocs(collection(db,'records'))
      let data=snap.docs.map(d=>({id:d.id,...d.data()}))
      if(session?.role==='manager') data=data.filter(r=>r.showroom===session.showroom)
      // Employee, branch and type are deliberately NOT applied here.
      // The whole collection is read either way, so narrowing now saves
      // nothing and costs accuracy: the day rows need every employee's
      // records to know which dates were working days at all. A cover day is
      // A cover day is also stored against the branch worked, so filtering
      // by branch now would make the person read as absent at home.
      // All three are applied below, where the day rows know about cover.
      // Dates are YYYY-MM-DD, so string comparison is already chronological
      if(fFrom)  data=data.filter(r=>r.date>=fFrom)
      if(fTo)    data=data.filter(r=>r.date<=fTo)
      if(fType)  data=data.filter(r=>r.type===fType)
      setAllRecs(data.sort((a,b)=>b.createdAt-a.createdAt))
    } catch { showToast('Error loading records.','error') }
    setLoading(false)
  }

  async function exportExcel() {
    if(!window.XLSX){ await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s)}) }
    const XL=window.XLSX
    const wb=XL.utils.book_new()
    const BLUE='1A6FE8', AMBER='D97706', PURPLE='6D28D9'
    // Same rows the screen is showing — the two can never drift apart
    const rows=dayRows
    if(!rows.length){ showToast('Nothing to export for this range.','error'); return }
    const head=(ws,hdrs,rgb)=>hdrs.forEach((_,ci)=>{const ref=XL.utils.encode_cell({r:0,c:ci});if(ws[ref])ws[ref].s={font:{bold:true,color:{rgb:'FFFFFF'},sz:10},fill:{patternType:'solid',fgColor:{rgb:rgb}},alignment:{horizontal:'center'}}})
    const sheet=(name,hdrs,data,widths,rgb)=>{
      const ws=XL.utils.aoa_to_sheet([hdrs,...data])
      ws['!cols']=widths.map(w=>({wch:w}))
      head(ws,hdrs,rgb)
      XL.utils.book_append_sheet(wb,ws,name)
    }

    // ── Sheet 1: Daily Attendance ──────────────────────────────────────────
    // Home Branch / Worked At / Left From / Cover make every branch move
    // visible on the row it happened on.
    const cols1=['Employee','Emp ID','Home Branch','Worked At','Left From','Cover','Date','Day','Status',
                 'Arrive Time','Depart Time','Shift Start','Shift End','Late By','Early Exit',
                 'Short Leave','Leave Reason','Work Hours','Target Hours','OT / Short','OT Flag']
    sheet('Daily Attendance',cols1,rows.map(r=>cols1.map(k=>r[k])),
      [22,9,13,13,12,13,11,6,14,11,11,10,10,9,10,11,22,13,12,12,9],BLUE)

    // ── Sheet 2: Employee Summary ──────────────────────────────────────────
    // Keyed by person, not person+branch, so a week of cover does not split
    // someone into two half-people. Branches Worked lists where they were.
    const em={}
    rows.forEach(r=>{
      const e=em[r.empId]||(em[r.empId]={name:r.Employee,id:r.empId,home:r['Home Branch'],
        days:0,absent:0,late:0,lateSec:0,half:0,noDep:0,leaves:0,cover:0,moved:0,workMin:0,otMin:0,branches:new Set()})
      if(r.Status==='Absent'){ e.absent++; return }
      e.days++
      if(r._workedAt) e.branches.add(r['Worked At'])
      if(r._isLate){ e.late++; e.lateSec+=r._lateSec }
      if(r.Status==='Half Day') e.half++
      if(r.Status==='No Departure') e.noDep++
      if(r['Short Leave']!=='—') e.leaves++
      if(r._covering) e.cover++
      if(r._moved)    e.moved++
      if(r._workMin!=null) e.workMin+=r._workMin
      if(r._otMin!=null)   e.otMin+=r._otMin
    })
    const sum2=['Employee','Emp ID','Home Branch','Branches Worked','Cover Days','Mid-Shift Moves',
                'Days Present','Days Absent','Late Arrivals','Total Late','Avg Late','Half Days',
                'No Departure','Short Leaves','Total Work Hrs','Avg Hrs/Day','Total OT/Short','Attendance %','Rating']
    const sumRows=Object.values(em).map(e=>{
      const total=e.days+e.absent
      const attend=total?Math.round(e.days/total*100):0
      const avg=e.days?Math.round(e.workMin/e.days):0
      const avgLate=e.late?Math.round(e.lateSec/e.late):0
      // Attendance weighs heaviest, then lateness, then unfinished days
      const score=Math.max(0,attend-e.late*3-e.half*4-e.noDep*2)
      const rating=score>=90?'Excellent':score>=75?'Good':score>=60?'Average':'Needs Improvement'
      return [e.name,e.id,e.home,[...e.branches].join(', ')||'—',e.cover,e.moved,
              e.days,e.absent,e.late,fmtGap(e.lateSec),fmtGap(avgLate),e.half,e.noDep,e.leaves,
              fmtH(e.workMin),fmtH(avg),(e.otMin>=0?'+':'-')+fmtH(e.otMin),attend+'%',rating]
    }).sort((a,b)=>a[0].localeCompare(b[0]))
    sheet('Employee Summary',sum2,sumRows,[22,9,13,26,11,15,13,12,13,11,10,10,13,12,14,12,14,12,17],BLUE)

    // ── Sheet 3: Branch Movements ──────────────────────────────────────────
    // Every cover day and every mid-shift move, on its own. This is the sheet
    // to check when someone was shifted to another showroom.
    const mv=rows.filter(r=>r._covering||r._moved)
    const mvH=['Date','Day','Employee','Emp ID','Home Branch','Checked In At','Checked Out At',
               'What Happened','Arrive Time','Depart Time','Shift Followed','Late By','Work Hours','Status']
    sheet('Branch Movements',mvH,mv.map(r=>[r.Date,r.Day,r.Employee,r['Emp ID'],r['Home Branch'],
      r['Worked At'],r['Left From']||r['Worked At'],
      r._covering&&r._moved ? `Covered at ${r['Worked At']}, left from ${r['Left From']}`
        : r._covering ? `Covered at ${r['Worked At']} (home ${r['Home Branch']})`
        : `Moved to ${r['Left From']} mid-shift`,
      r['Arrive Time'],r['Depart Time'],`${r['Shift Start']}–${r['Shift End']} (${r['Worked At']})`,
      r['Late By'],r['Work Hours'],r.Status]),
      [11,6,22,9,13,14,15,40,11,11,22,9,13,14],PURPLE)

    // ── Sheet 4: Absences ──────────────────────────────────────────────────
    const abs=rows.filter(r=>r.Status==='Absent')
    sheet('Absences',['Date','Day','Employee','Emp ID','Home Branch','Note'],
      abs.map(r=>[r.Date,r.Day,r.Employee,r['Emp ID'],r['Home Branch'],
        'No arrival recorded at any branch']),[11,6,22,9,13,34],AMBER)

    // ── Sheet 5: Late Arrivals ─────────────────────────────────────────────
    const late=rows.filter(r=>r._isLate).sort((a,b)=>b._lateSec-a._lateSec)
    sheet('Late Arrivals',['Date','Day','Employee','Worked At','Cover','Shift Start','Arrive Time','Late By'],
      late.map(r=>[r.Date,r.Day,r.Employee,r['Worked At'],r.Cover||'—',r['Shift Start'],r['Arrive Time'],r['Late By']]),
      [11,6,22,13,13,11,11,9],AMBER)

    // ── Sheet 6: OT & Hours ────────────────────────────────────────────────
    const ot=rows.filter(r=>r['OT Flag']==='OT'||r['OT Flag']==='Short')
      .sort((a,b)=>Math.abs(b._otMin||0)-Math.abs(a._otMin||0))
    sheet('OT & Hours',['Date','Employee','Worked At','Cover','Arrive Time','Depart Time','Work Hours','Target Hours','OT / Short','Flag'],
      ot.map(r=>[r.Date,r.Employee,r['Worked At'],r.Cover||'—',r['Arrive Time'],r['Depart Time'],
                 r['Work Hours'],r['Target Hours'],r['OT / Short'],r['OT Flag']]),
      [11,22,13,13,11,11,13,12,12,9],BLUE)

    // ── Sheet 7: Needs Checking ────────────────────────────────────────────
    // Arrived but never clocked out, or clocked out before clocking in.
    const chk=rows.filter(r=>r.Status==='No Departure'||r.Status==='Check Records'||r._badBranch)
    sheet('Needs Checking',['Date','Employee','Worked At','Left From','Arrive Time','Depart Time','Problem','Action'],
      chk.map(r=>[r.Date,r.Employee,r['Worked At'],r['Left From']||'—',r['Arrive Time'],r['Depart Time'],
        r._badBranch ? `Branch name "${r._workedAt}" is not one of the three showrooms`
          : r.Status==='Check Records' ? 'Departure is earlier than arrival'
          : 'No departure recorded',
        r._badBranch ? 'Misspelt branch in Firestore — correct it or this day is missing from branch reports'
          : r.Status==='Check Records' ? 'Likely a past-midnight checkout — confirm and correct'
          : 'Check if on company duty or forgot to check out']),
      [11,22,13,12,11,11,32,42],AMBER)

    const span=(!fFrom&&!fTo) ? 'all-time'
             : fFrom===fTo    ? fFrom
             : `${fFrom||'start'}_to_${fTo||'today'}`
    XL.writeFile(wb,`idealz-attendance-${span}.xlsx`)
    showToast(`✅ Excel downloaded — ${rows.length} day rows, ${mv.length} branch moves`)
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

  // Both views and the Excel export come off these three lines
  const dayRows = buildDayRows(allRecs, employees, fRoom, fEmp)
  const rptKPI  = dayRowKPIs(dayRows)
  const rawRecs = allRecs.filter(r=>(!fRoom||r.showroom===fRoom)&&(!fEmp||r.empId===fEmp)&&(!fType||r.type===fType))

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
          {session?.role==='admin'&&<a href="/analytics" style={{...S.tab,textDecoration:'none',display:'flex',alignItems:'center',color:'#64748b'}}>Analytics</a>}
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
        {session.role==='employee'&&!detecting&&awayFrom&&(
          <div style={{marginBottom:16,padding:'12px 16px',borderRadius:10,background:'#FAECE7',border:'1px solid #F0CDBF',fontSize:'0.82rem',color:'#993C1D'}}>
            <div style={{display:'flex',alignItems:'flex-start',gap:10}}>
              <span style={{fontSize:'1.1rem',lineHeight:1.3}}>📍</span>
              <div style={{flex:1}}>
                <div style={{fontWeight:600,marginBottom:3}}>You are not at a showroom</div>
                <div style={{lineHeight:1.5}}>
                  Nearest is <strong>{dn(awayFrom.room)}</strong>, about {awayFrom.distance.toLocaleString()}m away.
                  Check in and out only works within {SHOWROOM_LOCATIONS[awayFrom.room]?.radius||50}m of the entrance.
                </div>
                <button onClick={()=>detectBranch()} disabled={detecting}
                  style={{marginTop:9,padding:'6px 14px',borderRadius:8,border:'1px solid #E0BCAB',background:'#fff',
                          color:'#993C1D',fontSize:'0.78rem',cursor:'pointer',fontFamily:'inherit'}}>
                  Check my location again
                </button>
              </div>
            </div>
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
          <span style={{fontSize:'0.75rem',color:'#6B7280'}}>From</span>
          <input type="date" style={{...S.sel,width:'auto',minWidth:140}} value={fFrom} max={fTo||undefined} onChange={e=>setFFrom(e.target.value)}/>
          <span style={{fontSize:'0.75rem',color:'#6B7280'}}>To</span>
          <input type="date" style={{...S.sel,width:'auto',minWidth:140}} value={fTo} min={fFrom||undefined} onChange={e=>setFTo(e.target.value)}/>
          <select style={{...S.sel,width:'auto',minWidth:120}} value={fType} onChange={e=>setFType(e.target.value)}>
            <option value="">All Types</option>
            <option value="arrive">Arrive</option>
            <option value="depart">Depart</option>
            <option value="leave">Leave</option>
            <option value="return">Return</option>
          </select>
          <button style={S.exportBtn} onClick={exportExcel}>⬇ Excel</button>
        </div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:16,alignItems:'center'}}>
          {[['today','Today'],['yesterday','Yesterday'],['week','This week'],['month','This month'],['last30','Last 30 days'],['all','All time']]
            .map(([k,label])=>(
            <button key={k} onClick={()=>applyPreset(k)} style={{padding:'5px 11px',borderRadius:14,border:'1px solid #E3E0D6',
              background:'#F8F7F3',color:'#5F5E5A',fontSize:'0.73rem',cursor:'pointer',fontFamily:'inherit'}}>{label}</button>
          ))}
          <span style={{fontSize:'0.73rem',color:'#8A8982',marginLeft:4}}>
            {(!fFrom&&!fTo) ? 'All records' : fFrom===fTo ? `${fFrom}` : `${fFrom||'start'} → ${fTo||'today'}`}
            {' · '}{rptKPI.days} day row{rptKPI.days===1?'':'s'} · {allRecs.length} record{allRecs.length===1?'':'s'}
          </span>
        </div>
        {rptKPI.badBranch>0 && <div style={{background:'#FAECE7',border:'1px solid #F0CDBF',borderRadius:10,
          padding:'10px 13px',marginBottom:12,fontSize:'0.76rem',color:'#993C1D',lineHeight:1.5}}>
          <b>{rptKPI.badBranch} day row{rptKPI.badBranch===1?'':'s'}</b> point at a branch name the app does not recognise —
          almost always a typo in Firestore (for example “Idealz Libert Plaza”). Those days appear under
          All&nbsp;Showrooms but are missing from every single-branch report. The Needs&nbsp;Checking sheet in
          Excel lists them with the exact spelling to fix.
        </div>}
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(104px,1fr))',gap:10,marginBottom:14}}>
          {[{l:'Day rows',v:rptKPI.days,c:'#5F5E5A'},
            {l:'Present',v:rptKPI.present,c:'#0F6E56'},
            {l:'Late',v:rptKPI.late,c:'#854F0B'},
            {l:'Absent',v:rptKPI.absent,c:'#993C1D'},
            {l:'Half day',v:rptKPI.halfDay,c:'#854F0B'},
            {l:'Cover days',v:rptKPI.cover,c:'#5B3DB5'},
            {l:'Branch moves',v:rptKPI.moved,c:'#5B3DB5'},
            {l:'Needs check',v:rptKPI.noDepart+rptKPI.broken,c:'#993C1D'}].map(s=>(
            <div key={s.l} style={{background:'#fff',border:'1px solid #E8E5DC',borderRadius:10,padding:'10px 12px'}}>
              <div style={{fontSize:'0.63rem',color:'#8A8982',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:3}}>{s.l}</div>
              <div style={{fontSize:'1.45rem',fontWeight:700,color:s.c,lineHeight:1.1}}>{s.v}</div>
            </div>
          ))}
        </div>

        <div style={{display:'flex',gap:6,marginBottom:12,alignItems:'center',flexWrap:'wrap'}}>
          {[['summary','Attendance summary'],['records','Raw check-ins']].map(([k,label])=>(
            <button key={k} onClick={()=>setRptView(k)} style={{padding:'6px 14px',borderRadius:16,cursor:'pointer',
              fontFamily:'inherit',fontSize:'0.75rem',fontWeight:rptView===k?600:400,
              border:'1px solid '+(rptView===k?'#1A6FE8':'#E3E0D6'),
              background:rptView===k?'#E8F1FD':'#F8F7F3',color:rptView===k?'#1A6FE8':'#5F5E5A'}}>{label}</button>
          ))}
          <span style={{fontSize:'0.71rem',color:'#8A8982',marginLeft:4}}>
            {rptView==='summary'
              ? 'One row per person per working day. Absences included. Excel exports exactly this.'
              : 'Every individual tap. The Type filter applies here only.'}
          </span>
        </div>

        {rptView==='summary' && <div className="table-scroll">
          {loading?<div style={{textAlign:'center',padding:32,color:'#8A8982'}}>Loading…</div>
            :dayRows.length===0
            ?<div style={{textAlign:'center',padding:32,color:'#8A8982',fontSize:'0.82rem'}}>No working days in this range.</div>
            :<table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.76rem',minWidth:1020}}>
              <thead><tr style={{borderBottom:'2px solid #E8E5DC'}}>
                {['Date','Employee','Home','Worked at','Status','Arrive','Depart','Shift','Late','Early out','Leave','Work hrs','OT / short'].map(h=>(
                  <th key={h} style={{textAlign:'left',padding:'8px 9px',color:'#8A8982',fontWeight:600,fontSize:'0.66rem',textTransform:'uppercase',letterSpacing:'.05em',whiteSpace:'nowrap'}}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {dayRows.map((r,ri)=>{
                  const sc={'Present':['#0F6E56','#E1F5EE'],'Late':['#854F0B','#FAEEDA'],
                            'Absent':['#993C1D','#FAECE7'],'Half Day':['#854F0B','#FAEEDA'],
                            'No Departure':['#993C1D','#FAECE7'],'Check Records':['#993C1D','#FAECE7']}[r.Status]||['#5F5E5A','#F1EFE8']
                  return (
                  <tr key={ri} style={{borderBottom:'1px solid #F1EFE8',background:r.Status==='Absent'?'#FFFBFA':(ri%2?'#FBFAF7':'#fff')}}>
                    <td style={{padding:'8px 9px',color:'#5F5E5A',whiteSpace:'nowrap'}}>{r.Date}<span style={{color:'#B5B3AB',marginLeft:5}}>{r.Day}</span></td>
                    <td style={{padding:'8px 9px',fontWeight:500,color:'#201F1C',whiteSpace:'nowrap'}}>{r.Employee}</td>
                    <td style={{padding:'8px 9px',color:'#8A8982',fontSize:'0.7rem',whiteSpace:'nowrap'}}>{r['Home Branch']}</td>
                    <td style={{padding:'8px 9px',whiteSpace:'nowrap'}}>
                      <span style={{color:r._covering?'#5B3DB5':'#5F5E5A',fontWeight:r._covering?600:400}}>{r['Worked At']}</span>
                      {/* A branch move is spelled out on the row it happened on */}
                      {r._covering&&<span style={{marginLeft:5,fontSize:'0.63rem',background:'#EFE9FB',color:'#5B3DB5',padding:'1px 6px',borderRadius:10}}>cover</span>}
                      {r._moved&&<span style={{marginLeft:4,fontSize:'0.63rem',background:'#EFE9FB',color:'#5B3DB5',padding:'1px 6px',borderRadius:10}}>→ {r['Left From']}</span>}
                    </td>
                    <td style={{padding:'8px 9px',whiteSpace:'nowrap'}}>
                      <span style={{fontSize:'0.68rem',fontWeight:600,color:sc[0],background:sc[1],padding:'2px 8px',borderRadius:12}}>{r.Status}</span>
                    </td>
                    <td style={{padding:'8px 9px',color:r._lateSec>GRACE_SEC?'#854F0B':'#0F6E56',whiteSpace:'nowrap'}}>{r['Arrive Time']}</td>
                    <td style={{padding:'8px 9px',color:r['Depart Time']==='—'?'#B5B3AB':'#201F1C',whiteSpace:'nowrap'}}>{r['Depart Time']}</td>
                    <td style={{padding:'8px 9px',color:'#8A8982',fontSize:'0.68rem',whiteSpace:'nowrap'}}>{r['Shift Start']}–{r['Shift End']}</td>
                    <td style={{padding:'8px 9px',color:r._lateSec>GRACE_SEC?'#854F0B':'#B5B3AB',fontWeight:r._lateSec>GRACE_SEC?600:400,whiteSpace:'nowrap'}}>{r['Late By']}</td>
                    <td style={{padding:'8px 9px',color:r._earlySec>0?'#993C1D':'#B5B3AB',whiteSpace:'nowrap'}}>{r['Early Exit']}</td>
                    <td style={{padding:'8px 9px',color:'#8A8982',fontSize:'0.7rem',maxWidth:110,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}
                        title={r['Leave Reason']!=='—'?r['Leave Reason']:''}>{r['Short Leave']}</td>
                    <td style={{padding:'8px 9px',fontWeight:600,color:r._workMin!=null?'#201F1C':'#B5B3AB',whiteSpace:'nowrap'}}>{r['Work Hours']}</td>
                    <td style={{padding:'8px 9px',whiteSpace:'nowrap'}}>
                      {r._otMin!=null
                        ?<span style={{fontSize:'0.68rem',fontWeight:600,
                            color:r._otMin>0?'#5B3DB5':r._otMin<0?'#993C1D':'#0F6E56',
                            background:r._otMin>0?'#EFE9FB':r._otMin<0?'#FAECE7':'#E1F5EE',padding:'2px 8px',borderRadius:12}}>
                          {r['OT / Short']}</span>
                        :<span style={{color:'#B5B3AB'}}>—</span>}
                    </td>
                  </tr>)
                })}
              </tbody>
            </table>}
        </div>}

        {rptView==='records' && <div className="table-scroll">
          {loading?<div style={{textAlign:'center',padding:32,color:'#8A8982'}}>Loading…</div>
            :<table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.76rem',minWidth:620}}>
              <thead><tr style={{borderBottom:'2px solid #E8E5DC'}}>
                {['Date','Time','Employee','Branch','Type','Duration','Reason'].map(h=>(
                  <th key={h} style={{textAlign:'left',padding:'8px 10px',color:'#8A8982',fontWeight:600,fontSize:'0.66rem',textTransform:'uppercase',letterSpacing:'.05em',whiteSpace:'nowrap'}}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {rawRecs.length===0
                  ?<tr><td colSpan={7} style={{textAlign:'center',color:'#8A8982',padding:32}}>No records found</td></tr>
                  :rawRecs.map((r,ri)=>{
                    const emp=employees.find(e=>e.empId===r.empId)
                    // Flags the tap itself as cover, so the raw log shows it too
                    const cov=emp&&emp.showroom&&r.showroom!==emp.showroom
                    return (
                    <tr key={r.id||ri} style={{borderBottom:'1px solid #F1EFE8',background:ri%2?'#FBFAF7':'#fff'}}>
                      <td style={{padding:'8px 10px',color:'#5F5E5A',whiteSpace:'nowrap'}}>{r.date}</td>
                      <td style={{padding:'8px 10px',color:'#201F1C',whiteSpace:'nowrap'}}>{r.time}</td>
                      <td style={{padding:'8px 10px',fontWeight:500,color:'#201F1C',whiteSpace:'nowrap'}}>{r.empName}</td>
                      <td style={{padding:'8px 10px',whiteSpace:'nowrap'}}>
                        <span style={{color:cov?'#5B3DB5':'#5F5E5A',fontSize:'0.72rem'}}>{dnShort(r.showroom)}</span>
                        {cov&&<span style={{marginLeft:5,fontSize:'0.62rem',background:'#EFE9FB',color:'#5B3DB5',padding:'1px 6px',borderRadius:10}}>cover</span>}
                      </td>
                      <td style={{padding:'8px 10px'}}><span style={badge(r.type,r.overdue)}>{r.type}</span></td>
                      <td style={{padding:'8px 10px',color:'#8A8982',whiteSpace:'nowrap'}}>{r.duration?`${r.duration}m`:'—'}</td>
                      <td style={{padding:'8px 10px',color:'#8A8982',fontSize:'0.72rem',maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={r.reason||''}>{r.reason||'—'}</td>
                    </tr>)
                  })}
              </tbody>
            </table>}
        </div>}
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
          {session?.role==='admin'&&<a href="/analytics" className="bnav-btn"><span className="bnav-icon">📈</span><span>Analytics</span></a>}
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
