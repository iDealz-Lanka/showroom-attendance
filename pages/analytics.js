import { useState, useEffect, useRef } from 'react'
import Head from 'next/head'
import { db } from '../lib/firebase'
import { collection, getDocs, query, where } from 'firebase/firestore'

const SHOWROOMS = [
  { key: 'Idealz Marino',       icon: '🏛️' },
  { key: 'Idealz Liberty Plaza', icon: '🏬' },
  { key: 'Idealz Prime',        icon: '🏪' },
]

const DISPLAY_NAMES = {
  'Idealz Marino':        'iDealz Marino',
  'Idealz Liberty Plaza': 'iSeven Mobile',
  'Idealz Prime':         'iDealz Prime',
}
function dn(showroom)      { return DISPLAY_NAMES[showroom] || showroom || '' }
function dnShort(showroom) { return dn(showroom).replace('iDealz ','') }

// Shift schedules per location + staff type
const SHIFTS = {
  'Idealz Marino':       { showroom:   { start:'10:00', end:'20:00' } },
  'Idealz Liberty Plaza': { showroom:   { start:'10:00', end:'19:00' } },
  'Idealz Prime':        { showroom:   { start:'09:45', end:'19:30' },
                           backoffice: { start:'09:30', end:'18:30' } },
}
// Seconds after shift start before an arrival counts as late.
// 60 = one minute of grace. 0 would be strict to the second,
// 300 would allow five minutes.
const GRACE_SEC = 60

function getShift(showroom, staffType='showroom') {
  const sh = SHIFTS[showroom]
  if (!sh) return { start:'09:00', end:'18:00' }
  return sh[staffType] || sh.showroom
}

function toMin(t) { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m }
// Seconds since midnight — records store HH:MM:SS, shift times store HH:MM
function toSec(t) { if (!t) return null; const [h,m,s] = t.split(':').map(Number); return h*3600 + m*60 + (s||0) }
// "+45s" under a minute, "+14m" above it
function fmtLate(sec) {
  if (!sec || sec <= 0) return ''
  return sec < 60 ? `+${sec}s` : `+${Math.floor(sec/60)}m`
}
function toStr(m) { if (m == null) return '—'; return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}` }
function fmtHrs(m) { if (!m || m <= 0) return '0h 0m'; return `${Math.floor(m/60)}h ${m%60}m` }
function today() { return new Date().toISOString().split('T')[0] }

function getWeekRange(d) {
  const dd = new Date(d)
  const day = dd.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const start = new Date(dd); start.setDate(dd.getDate() + diff)
  const end = new Date(start); end.setDate(start.getDate() + 6)
  return { start, end }
}

function dateStr(d) { return d.toISOString().split('T')[0] }

// ── fetch records from Firebase ──────────────────────────────────────────────
async function fetchRecords(filters = {}) {
  const col = collection(db, 'records')
  let constraints = []
  if (filters.date)     constraints.push(where('date',     '==', filters.date))
  if (filters.showroom) constraints.push(where('showroom', '==', filters.showroom))
  if (filters.dateGte)  constraints.push(where('date',     '>=', filters.dateGte))
  if (filters.dateLte)  constraints.push(where('date',     '<=', filters.dateLte))
  try {
    const snap = await getDocs(constraints.length ? query(col, ...constraints) : col)
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch {
    const snap = await getDocs(col)
    let data = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    if (filters.date)     data = data.filter(r => r.date     === filters.date)
    if (filters.showroom) data = data.filter(r => r.showroom === filters.showroom)
    if (filters.dateGte)  data = data.filter(r => r.date     >= filters.dateGte)
    if (filters.dateLte)  data = data.filter(r => r.date     <= filters.dateLte)
    return data
  }
}

async function fetchEmployees() {
  const snap = await getDocs(collection(db, 'employees'))
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

// ── derive per-employee day stats ─────────────────────────────────────────────
function deriveStats(empId, dateRecords, showroom, staffType='showroom') {
  const recs = dateRecords.filter(r => r.empId === empId)
  if (!recs.length) return null

  const arrRec  = recs.find(r => r.type === 'arrive')
  const depRec  = recs.find(r => r.type === 'depart')

  // Hours follow the branch actually worked that day, so someone covering
  // at Prime is judged against Prime's 09:45, not their home branch's 10:00.
  const workedAt   = arrRec?.showroom || depRec?.showroom || showroom
  const covering   = workedAt !== showroom
  // Started at one branch, left from another — a mid-shift move
  const departedAt  = depRec?.showroom || null
  const crossBranch = !!(arrRec && depRec && arrRec.showroom !== depRec.showroom)
  const shift = getShift(workedAt, staffType)
  const sMin = toMin(shift.start), eMin = toMin(shift.end)
  const leaveRecs = recs.filter(r => r.type === 'leave')

  const arrive  = arrRec  ? toMin(arrRec.time)  : null
  const depart  = depRec  ? toMin(depRec.time)  : null
  const leaveDur = leaveRecs.reduce((a, r) => a + (r.duration || 0), 0)
  const leaveReasons = leaveRecs.map(r => r.reason).filter(Boolean).join(', ')

  // Lateness measured in seconds so a single second past the start counts
  const sSec      = toSec(shift.start)
  const arrSec    = arrRec ? toSec(arrRec.time) : null
  const lateSec   = arrSec != null && arrSec > sSec ? arrSec - sSec : 0
  const lateBy    = Math.floor(lateSec / 60)
  const earlyExit = depart != null && depart < eMin ? eMin - depart : 0
  const workMin   = arrive != null && depart != null ? Math.max(0, depart - arrive - leaveDur) : null
  const shiftMin  = eMin - sMin
  const halfDay   = workMin != null && workMin > 0 && workMin < shiftMin / 2

  return { arrive, depart, lateBy, lateSec, earlyExit, leaveDur, leaveReasons, workMin, halfDay, sMin, eMin, workedAt, covering, departedAt, crossBranch }
}

// ─────────────────────────────────────────────────────────────────────────────
export default function Analytics() {
  const [view,    setView]    = useState('day')
  const [curDate, setCurDate] = useState(new Date())
  const [room,    setRoom]    = useState('all')
  const [emps,    setEmps]    = useState([])
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [monthSort, setMonthSort] = useState('late') // 'late' | 'absent' | 'name' | 'days'
  const [dayFilter, setDayFilter] = useState('all')  // 'all' | 'present' | 'absent' | 'late'
  const chartRef = useRef(null)
  const chartInst = useRef(null)

  useEffect(() => { fetchEmployees().then(setEmps) }, [])

  useEffect(() => {
    setLoading(true)
    let filters = {}
    if (view === 'day') {
      filters.date = dateStr(curDate)
    } else if (view === 'week') {
      const { start, end } = getWeekRange(curDate)
      filters.dateGte = dateStr(start); filters.dateLte = dateStr(end)
    } else {
      const y = curDate.getFullYear(), m = curDate.getMonth()
      filters.dateGte = `${y}-${String(m+1).padStart(2,'0')}-01`
      filters.dateLte = `${y}-${String(m+1).padStart(2,'0')}-${String(new Date(y,m+1,0).getDate()).padStart(2,'0')}`
    }
    // Deliberately NOT filtered by branch here. A cover day is stored against
    // the branch worked, so filtering server-side would hide it and the person
    // would look absent. Branch filtering happens below, per date.
    
    fetchRecords(filters).then(r => { setRecords(r); setLoading(false) })
  }, [view, curDate, room])

  // ── helpers ────────────────────────────────────────────────────────────────
  const filteredEmps = room === 'all' ? emps : emps.filter(e => e.showroom === room)

  // Who counts as "this branch" on a given date:
  //   worked here that day (including cover from another branch), or
  //   based here and did not work anywhere (so they show as absent here).
  // Someone based here who covered elsewhere belongs to that branch today.
  function rosterFor(dayRecs, forRoom) {
    if (forRoom === 'all') return emps
    return emps.filter(e => {
      const arr = dayRecs.find(r => r.empId === e.empId && r.type === 'arrive')
      return arr ? arr.showroom === forRoom : e.showroom === forRoom
    })
  }

  function navDate(dir) {
    const d = new Date(curDate)
    if (view === 'day')   d.setDate(d.getDate() + dir)
    if (view === 'week')  d.setDate(d.getDate() + dir * 7)
    if (view === 'month') d.setMonth(d.getMonth() + dir)
    setCurDate(d)
  }

  function dateLbl() {
    if (view === 'day')   return curDate.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' })
    if (view === 'week') {
      const { start, end } = getWeekRange(curDate)
      return start.toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + ' – ' + end.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})
    }
    return curDate.toLocaleDateString('en-GB', { month:'long', year:'numeric' })
  }

  // ── KPI compute ────────────────────────────────────────────────────────────
  function computeWorkingHrsKPI() {
    const dates = view === 'day'
      ? [dateStr(curDate)]
      : view === 'week'
        ? (() => { const { start } = getWeekRange(curDate); return Array.from({length:7},(_,i)=>{ const d=new Date(start); d.setDate(d.getDate()+i); return dateStr(d) }) })()
        : (() => { const y=curDate.getFullYear(),m=curDate.getMonth(),days=new Date(y,m+1,0).getDate(); return Array.from({length:days},(_,i)=>`${y}-${String(m+1).padStart(2,'0')}-${String(i+1).padStart(2,'0')}`) })()

    let totalWorked=0, totalTarget=0, empCount=0
    dates.forEach(d => {
      const dayRecs = records.filter(r => r.date === d)
      filteredEmps.forEach(emp => {
        const s = deriveStats(emp.empId, dayRecs, emp.showroom, emp.staffType||'showroom')
        if (!s || s.arrive==null || s.workMin==null) return
        const shift = getShift(emp.showroom, emp.staffType||'showroom')
        const shiftMin = toMin(shift.end) - toMin(shift.start)
        totalWorked += s.workMin
        totalTarget += shiftMin
        empCount++
      })
    })
    const diff = totalWorked - totalTarget
    return { totalWorked, totalTarget, diff, empCount }
  }

  function computeKPIs() {
    const todayKPI = new Date().toISOString().split('T')[0]
    const dates = (view === 'day'
      ? [dateStr(curDate)]
      : view === 'week'
        ? (() => { const { start } = getWeekRange(curDate); return Array.from({length:7},(_,i)=>{ const d=new Date(start); d.setDate(d.getDate()+i); return dateStr(d) }) })()
        : (() => { const y=curDate.getFullYear(),m=curDate.getMonth(),days=new Date(y,m+1,0).getDate(); return Array.from({length:days},(_,i)=>`${y}-${String(m+1).padStart(2,'0')}-${String(i+1).padStart(2,'0')}`) })()
    ).filter(d => d <= todayKPI) // Never count future dates — all days count including weekends

    let present=0, absent=0, late=0, earlyEx=0, leaves=0, halfDays=0, totalMin=0, count=0
    dates.forEach(d => {
      const dayRecs = records.filter(r => r.date === d)
      rosterFor(dayRecs, room).forEach(emp => {
        const hasArrive = dayRecs.some(r => r.empId === emp.empId && r.type === 'arrive')
        // No arrival record for this date = absent
        if (!hasArrive) { absent++; return }
        const s = deriveStats(emp.empId, dayRecs, emp.showroom, emp.staffType||'showroom')
        if (!s) return
        if (s.arrive != null) { present++; if (s.workMin) { totalMin += s.workMin; count++ } }
        if (s.lateSec > GRACE_SEC) late++
        if (s.earlyExit > 0) earlyEx++
        if (s.leaveDur > 0) leaves++
        if (s.halfDay) halfDays++
      })
    })
    const avgHrs = count ? Math.round(totalMin / count) : 0
    return { present, absent, late, earlyEx, leaves, halfDays, avgHrs }
  }

  const kpis = emps.length ? computeKPIs() : {}

  // ── render helpers ─────────────────────────────────────────────────────────
  function badge(txt, type) {
    const map = { ok:'#E1F5EE:#0F6E56', warn:'#FAEEDA:#854F0B', danger:'#FAECE7:#993C1D', info:'#E6F1FB:#185FA5', gray:'#F1EFE8:#5F5E5A' }
    const [bg,col] = (map[type]||map.gray).split(':')
    return <span style={{ background:bg, color:col, padding:'2px 8px', borderRadius:4, fontSize:11, fontWeight:500 }}>{txt}</span>
  }

  function statusBadge(s) {
    if (!s || s.arrive == null) return badge('Absent','danger')
    if (s.halfDay)  return badge('Half day','warn')
    if (s.lateSec > GRACE_SEC) return badge('Late','warn')
    return badge('Present','ok')
  }

  // ── Day view ───────────────────────────────────────────────────────────────
  function DayView() {
    const dayRecs = records.filter(r => r.date === dateStr(curDate))

    // Each employee falls into exactly one bucket for this date
    const tagged = rosterFor(dayRecs, room).map(emp => {
      const s = deriveStats(emp.empId, dayRecs, emp.showroom, emp.staffType||'showroom')
      const cat = (!s || s.arrive == null) ? 'absent'
                : s.lateSec > GRACE_SEC     ? 'late'
                : 'ontime'
      return { emp, s, cat, isAbsent: cat === 'absent' }
    })

    const onTimeCount = tagged.filter(t => t.cat === 'ontime').length
    const lateCount   = tagged.filter(t => t.cat === 'late').length
    const absentCount = tagged.filter(t => t.cat === 'absent').length

    // Problems first: absent, then late, then on time
    const rank = { absent:0, late:1, ontime:2 }
    const shown = tagged
      .filter(t => dayFilter === 'all' || t.cat === dayFilter)
      .sort((a,b) => rank[a.cat] - rank[b.cat])

    const chips = [
      { k:'all',    label:`All ${tagged.length}`,      bg:'#F1EFE8', col:'#5F5E5A' },
      { k:'ontime', label:`On time ${onTimeCount}`,    bg:'#E1F5EE', col:'#0F6E56' },
      { k:'late',   label:`Late ${lateCount}`,         bg:'#FAEEDA', col:'#854F0B' },
      { k:'absent', label:`Absent ${absentCount}`,     bg:'#FAECE7', col:'#993C1D' },
    ]

    // Name lists — late sorted worst-first, the rest alphabetical
    const byName = (a,b) => a.emp.name.localeCompare(b.emp.name)
    const onTimeList = tagged.filter(t => t.cat === 'ontime').sort(byName)
    const lateList   = tagged.filter(t => t.cat === 'late').sort((a,b) => b.s.lateSec - a.s.lateSec)
    const absentList = tagged.filter(t => t.cat === 'absent').sort(byName)

    // One roll-call column: coloured header + the names beneath it
    function RollCall({ title, people, accent, bg, border, empty }) {
      return (
        <div style={{ ...S.section, marginBottom:0 }}>
          <div style={{ padding:'10px 14px', background:bg, borderBottom:`1px solid ${border}`,
                        display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <span style={{ fontSize:13, fontWeight:600, color:accent }}>{title}</span>
            <span style={{ fontSize:16, fontWeight:600, color:accent }}>{people.length}</span>
          </div>
          <div style={{ padding:'10px 14px', maxHeight:280, overflowY:'auto' }}>
            {people.length === 0
              ? <div style={{ fontSize:12, color:'var(--color-text-secondary)', padding:'6px 0' }}>{empty}</div>
              : people.map(({ emp, s }) => (
                  <div key={emp.id} style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between',
                                             gap:10, padding:'5px 0',
                                             borderBottom:'0.5px solid var(--color-border-tertiary)' }}>
                    <span style={{ fontSize:13 }}>{emp.name}</span>
                    <span style={{ fontSize:11, color:'var(--color-text-secondary)', whiteSpace:'nowrap' }}>
                      {dnShort(s?.workedAt || emp.showroom)}
                      {s?.crossBranch
                        ? <span style={{ color:'#185FA5', fontWeight:600 }}> → {dnShort(s.departedAt)}</span>
                        : null}
                      {s?.covering
                        ? <span style={{ color:'#854F0B', fontWeight:600 }}> (cover)</span>
                        : null}
                      {s && s.arrive != null ? ` · ${toStr(s.arrive)}` : ''}
                      {s && s.lateSec > GRACE_SEC
                        ? <strong style={{ color:'#854F0B', marginLeft:6 }}>{fmtLate(s.lateSec)}</strong>
                        : null}
                    </span>
                  </div>
                ))}
          </div>
        </div>
      )
    }

    return (
      <>
      {/* Roll call — who is in, who is not */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))', gap:12, marginBottom:12 }}>
        <RollCall title="On time" people={onTimeList} accent="#0F6E56" bg="#E1F5EE" border="#9FE1CB" empty="Nobody on time" />
        <RollCall title="Late"    people={lateList}   accent="#854F0B" bg="#FAEEDA" border="#FAC775" empty="Nobody late" />
        <RollCall title="Absent"  people={absentList} accent="#993C1D" bg="#FAECE7" border="#F5C4B3" empty="Everyone checked in" />
      </div>

      <div style={S.section}>
        <div style={{ ...S.secHead, flexWrap:'wrap', gap:10 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <span style={S.secTitle}>Employee detail</span>
            <span style={S.secSub}>{dateStr(curDate)}</span>
          </div>
          <div style={{ display:'flex', gap:6 }}>
            {chips.map(ch => {
              const on = dayFilter === ch.k
              return (
                <button key={ch.k} onClick={() => setDayFilter(ch.k)}
                  style={{ padding:'4px 12px', borderRadius:20, fontSize:12, cursor:'pointer',
                           fontWeight: on ? 600 : 400,
                           border:`1px solid ${on ? ch.col : 'var(--color-border-tertiary)'}`,
                           background: on ? ch.bg : 'transparent',
                           color: on ? ch.col : 'var(--color-text-secondary)' }}>
                  {ch.label}
                </button>
              )
            })}
          </div>
        </div>
        <div style={{ overflowX:'auto' }}>
          <table style={S.table}>
            <thead><tr>
              {['Employee','Showroom','Status','Arrived','Departed','Late by','Early exit','Leave','Hours worked'].map(h =>
                <th key={h} style={S.th}>{h}</th>
              )}
            </tr></thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={9} style={{ ...S.td, textAlign:'center', color:'var(--color-text-secondary)', padding:'20px 12px' }}>
                  {dayFilter === 'absent' ? 'Nobody absent on this date' : 'Nobody present on this date'}
                </td></tr>
              )}
              {shown.map(({ emp, s, isAbsent }) => {
                return (
                  <tr key={emp.id} style={{ ...S.tr, background: isAbsent ? 'rgba(250,236,231,0.45)' : 'transparent' }}>
                    <td style={S.td}>{emp.name}</td>
                    <td style={S.td}>
                      {badge(dnShort(s?.workedAt || emp.showroom),'info')}
                      {s?.crossBranch && <span style={{marginLeft:4,fontSize:11,color:'#185FA5',fontWeight:600}} title={`Checked in at ${dnShort(s.workedAt)}, checked out at ${dnShort(s.departedAt)}`}>→ {dnShort(s.departedAt)}</span>}
                      {s?.covering && <span style={{marginLeft:4,fontSize:10,background:'#FAEEDA',color:'#854F0B',padding:'1px 6px',borderRadius:3}} title={`Normally ${dnShort(emp.showroom)}`}>cover</span>}
                      {emp.staffType==='backoffice'&&<span style={{marginLeft:4,fontSize:10,background:'#FAEEDA',color:'#854F0B',padding:'1px 6px',borderRadius:3}}>Back Office</span>}
                    </td>
                    <td style={S.td}>{statusBadge(s)}</td>
                    <td style={{ ...S.td, color: s?.lateSec > GRACE_SEC ? '#BA7517' : 'var(--color-text-primary)' }}>{s ? toStr(s.arrive) : '—'}</td>
                    <td style={{ ...S.td, color: s?.earlyExit > 0 ? '#D85A30' : 'var(--color-text-primary)' }}>{s ? toStr(s.depart) : '—'}</td>
                    <td style={S.td}>{s?.lateSec > GRACE_SEC ? badge(fmtLate(s.lateSec),'warn') : s ? badge('On time','ok') : '—'}</td>
                    <td style={S.td}>{s?.earlyExit > 0 ? badge(`-${s.earlyExit}m`,'danger') : '—'}</td>
                    <td style={S.td}>{s?.leaveDur > 0 ? badge(`${s.leaveDur}m`,'info') : '—'}</td>
                    <td style={S.td}>
                      {s?.workMin != null ? (() => {
                        const shiftMin = s.eMin - s.sMin
                        const pct = Math.min(100, Math.round(s.workMin / shiftMin * 100))
                        const diff = s.workMin - shiftMin
                        const overtime = diff > 0
                        const undertime = diff < 0
                        return (
                          <div>
                            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                              <div style={{ flex:1, height:6, background:'var(--color-background-secondary)', borderRadius:3, overflow:'hidden', minWidth:60 }}>
                                <div style={{ height:'100%', borderRadius:3, width:`${pct}%`, background: s.halfDay?'#BA7517':overtime?'#7C3AED':'#1D9E75' }}/>
                              </div>
                              <span style={{ fontSize:12, fontWeight:600, color: s.halfDay?'#BA7517':overtime?'#7C3AED':'#1D9E75', minWidth:52 }}>{fmtHrs(s.workMin)}</span>
                            </div>
                            <div style={{ fontSize:10, color:'var(--color-text-secondary)' }}>
                              Target: {fmtHrs(shiftMin)}
                              {overtime && <span style={{ color:'#7C3AED', marginLeft:6 }}>+{fmtHrs(diff)} OT</span>}
                              {undertime && <span style={{ color:'#D85A30', marginLeft:6 }}>-{fmtHrs(Math.abs(diff))} short</span>}
                            </div>
                          </div>
                        )
                      })() : <span style={{color:'var(--color-text-secondary)',fontSize:11}}>No departure yet</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      </>
    )
  }

  // ── Week view ──────────────────────────────────────────────────────────────
  function WeekView() {
    const { start } = getWeekRange(curDate)
    const days = Array.from({length:7}, (_,i) => { const d=new Date(start); d.setDate(d.getDate()+i); return d })
    return (
      <div style={S.section}>
        <div style={S.secHead}><span style={S.secTitle}>Weekly summary</span></div>
        <div style={{ overflowX:'auto' }}>
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>Employee</th>
              {days.map(d => (
                <th key={d} style={{...S.th,minWidth:90}}>
                  {d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric'})}
                  <div style={{fontSize:9,color:'var(--color-text-secondary)',fontWeight:400}}>In / Out</div>
                </th>
              ))}
              <th style={S.th}>Total hrs</th>
              <th style={S.th}>Late</th>
              <th style={S.th}>Early exits</th>
              <th style={S.th}>Leaves</th>
              <th style={S.th}>Half days</th>
            </tr></thead>
            <tbody>
              {filteredEmps.map(emp => {
                const stats = days.map(d => deriveStats(emp.empId, records.filter(r=>r.date===dateStr(d)), emp.showroom, emp.staffType||'showroom'))
                const totalMin = stats.reduce((a,s) => a + (s?.workMin||0), 0)
                const lates    = stats.filter(s=>s?.lateSec > GRACE_SEC).length
                const earlyEx  = stats.filter(s=>s?.earlyExit>0).length
                const leaves   = stats.filter(s=>s?.leaveDur>0).length
                const halfDays = stats.filter(s=>s?.halfDay).length
                return (
                  <tr key={emp.id} style={S.tr}>
                    <td style={S.td}><span style={{fontWeight:500}}>{emp.name.split(' ')[0]}</span> <span style={{color:'var(--color-text-secondary)',fontSize:12}}>{emp.name.split(' ').slice(1).join(' ')}</span></td>
                    {stats.map((s,i) => (
                      <td key={i} style={{...S.td,minWidth:90}}>
                        {!s
                          ? <span style={{color:'var(--color-text-secondary)',fontSize:11}}>—</span>
                          : s.arrive == null
                            ? badge('Abs','danger')
                            : <div>
                                <div style={{color: s.lateSec > GRACE_SEC?'#BA7517':'#1D9E75', fontSize:11, fontWeight:500}}>
                                  ↑ {toStr(s.arrive)}
                                </div>
                                <div style={{color: s.earlyExit>0?'#D85A30':'#64748b', fontSize:11}}>
                                  {s.depart != null ? `↓ ${toStr(s.depart)}` : <span style={{color:'#f59e0b'}}>No out</span>}
                                </div>
                              </div>
                        }
                      </td>
                    ))}
                    <td style={S.td}>
                      {(() => {
                        const shift = getShift(emp.showroom, emp.staffType||'showroom')
                        const weekDays = stats.filter(s=>s).length
                        const targetMin = (toMin(shift.end) - toMin(shift.start)) * weekDays
                        const diff = totalMin - targetMin
                        return (
                          <div>
                            <div style={{ fontSize:13, fontWeight:600, color: diff>=0?'#1D9E75':'#D85A30' }}>{fmtHrs(totalMin)}</div>
                            <div style={{ fontSize:10, color:'var(--color-text-secondary)' }}>Target: {fmtHrs(targetMin)}</div>
                            {diff!==0 && <div style={{ fontSize:10, color: diff>0?'#7C3AED':'#D85A30' }}>{diff>0?'+':''}{fmtHrs(Math.abs(diff))} {diff>0?'OT':'short'}</div>}
                          </div>
                        )
                      })()}
                    </td>
                    <td style={S.td}>{lates > 0   ? badge(lates,'warn')   : <span style={{color:'var(--color-text-secondary)'}}>0</span>}</td>
                    <td style={S.td}>{earlyEx > 0 ? badge(earlyEx,'danger') : <span style={{color:'var(--color-text-secondary)'}}>0</span>}</td>
                    <td style={S.td}>{leaves > 0  ? badge(leaves,'info')  : <span style={{color:'var(--color-text-secondary)'}}>0</span>}</td>
                    <td style={S.td}>{halfDays > 0 ? badge(halfDays,'warn') : <span style={{color:'var(--color-text-secondary)'}}>0</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  // ── Month view ─────────────────────────────────────────────────────────────
  function MonthView() {
    const y = curDate.getFullYear(), m = curDate.getMonth()
    const daysInMonth = new Date(y, m+1, 0).getDate()
    const todayStr = new Date().toISOString().split('T')[0]

    // Build list of valid days up to today — NO weekend skipping
    // Every day counts — if employee didn't check in, it's absent
    const validWorkDays = []
    for (let d=1; d<=daysInMonth; d++) {
      const ds = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
      if (ds > todayStr) continue // skip future dates only
      validWorkDays.push(ds)
    }

    return (
      <>
        <div style={S.section}>
          <div style={S.secHead}>
            <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
              <span style={S.secTitle}>Monthly employee summary</span>
              <span style={{fontSize:11,color:'var(--color-text-secondary)'}}>
                {validWorkDays.length} days (up to {todayStr})
              </span>
            </div>
            <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
              <span style={{fontSize:11,color:'var(--color-text-secondary)'}}>Sort by:</span>
              {[
                {k:'late',   l:'🟠 Late Arrivals'},
                {k:'absent', l:'🔴 Absents'},
                {k:'days',   l:'✅ Days In'},
                {k:'name',   l:'🔤 Name'},
              ].map(s=>(
                <button key={s.k} onClick={()=>setMonthSort(s.k)}
                  style={{padding:'3px 10px',borderRadius:20,border:'1px solid',fontSize:11,cursor:'pointer',fontWeight:monthSort===s.k?700:400,
                    borderColor:monthSort===s.k?'#1A6FE8':'var(--color-border-tertiary)',
                    background:monthSort===s.k?'#E8F1FD':'transparent',
                    color:monthSort===s.k?'#1A6FE8':'var(--color-text-secondary)'}}>
                  {s.l}
                </button>
              ))}
            </div>
          </div>
          <div style={{ overflowX:'auto' }}>
            <table style={S.table}>
              <thead><tr>
                {['Employee','Showroom','Working Days','Days In','Absent','Late Arrivals','Early Exits','Half Days','Short Leaves','Total Hrs'].map(h =>
                  <th key={h} style={S.th}>{h}</th>
                )}
              </tr></thead>
              <tbody>
                {[...filteredEmps]
                  .map(emp => {
                    const empRecords = records.filter(r => r.empId === emp.empId)
                    if (empRecords.length === 0) return null
                    // Pre-calculate stats for sorting
                    // Same days for all — from day 1 of month
                    const cDays = validWorkDays
                    let lateCount=0, absentCount=0, daysInCount=0
                    cDays.forEach(ds=>{
                      const dayRecs = records.filter(r=>r.date===ds)
                      const empDayRecs = dayRecs.filter(r=>r.empId===emp.empId)
                      if(empDayRecs.length===0||!empDayRecs.some(r=>r.type==='arrive')){absentCount++;return}
                      const s = deriveStats(emp.empId, dayRecs, emp.showroom, emp.staffType||'showroom')
                      if(!s) return
                      daysInCount++
                      if(s.lateSec > GRACE_SEC) lateCount++
                    })
                    return { emp, lateCount, absentCount, daysInCount }
                  })
                  .filter(Boolean)
                  .sort((a,b) => {
                    if (monthSort==='late')   return b.lateCount - a.lateCount
                    if (monthSort==='absent') return b.absentCount - a.absentCount
                    if (monthSort==='days')   return b.daysInCount - a.daysInCount
                    if (monthSort==='name')   return a.emp.name.localeCompare(b.emp.name)
                    return b.lateCount - a.lateCount
                  })
                  .map(({ emp }) => {
                  const empRecords = records.filter(r => r.empId === emp.empId)
                  if (empRecords.length === 0) return null

                  let daysIn=0, absent=0, late=0, earlyEx=0, halfDs=0, leaves=0, totalMin=0

                  // All employees count from day 1 of month — same working days for everyone
                  const countableDays = validWorkDays

                  const shift = getShift(emp.showroom, emp.staffType||'showroom')
                  const shiftMin = toMin(shift.end) - toMin(shift.start)
                  const targetMin = shiftMin * countableDays.length

                  countableDays.forEach(ds => {
                    const dayRecs = records.filter(r => r.date === ds)
                    const empDayRecs = dayRecs.filter(r => r.empId === emp.empId)

                    if (empDayRecs.length === 0) {
                      absent++
                      return
                    }

                    const s = deriveStats(emp.empId, dayRecs, emp.showroom, emp.staffType||'showroom')
                    if (!s) { absent++; return }

                    // Only count as present if they have an arrive record
                    const hasArrive = empDayRecs.some(r => r.type === 'arrive')
                    if (!hasArrive) { absent++; return }

                    daysIn++
                    if (s.lateSec > GRACE_SEC)    late++
                    if (s.earlyExit > 0) earlyEx++
                    if (s.halfDay)       halfDs++
                    if (s.leaveDur > 0)  leaves++
                    if (s.workMin)       totalMin += s.workMin
                  })

                  const otMin = totalMin - targetMin
                  const avgMin = daysIn > 0 ? Math.round(totalMin / daysIn) : 0

                  return (
                    <tr key={emp.id} style={S.tr}>
                      <td style={{...S.td,fontWeight:500}}>{emp.name}</td>
                      <td style={S.td}>
                        {badge(dnShort(emp.showroom),'info')}
                        {emp.staffType==='backoffice'&&<span style={{marginLeft:4,fontSize:10,background:'#FAEEDA',color:'#854F0B',padding:'1px 6px',borderRadius:3}}>Back Office</span>}
                      </td>
                      <td style={{...S.td,color:'var(--color-text-secondary)'}}>{countableDays.length}</td>
                      <td style={{...S.td,fontWeight:600,color:'#1D9E75'}}>{daysIn}</td>
                      <td style={S.td}>{absent > 0   ? badge(absent,'danger')  : <span style={{color:'var(--color-text-secondary)'}}>0</span>}</td>
                      <td style={S.td}>{late > 0     ? badge(late,'warn')      : <span style={{color:'var(--color-text-secondary)'}}>0</span>}</td>
                      <td style={S.td}>{earlyEx > 0  ? badge(earlyEx,'warn')   : <span style={{color:'var(--color-text-secondary)'}}>0</span>}</td>
                      <td style={S.td}>{halfDs > 0   ? badge(halfDs,'warn')    : '0'}</td>
                      <td style={S.td}>{leaves > 0   ? badge(leaves,'info')    : <span style={{color:'var(--color-text-secondary)'}}>0</span>}</td>
                      <td style={{...S.td,fontWeight:600,color:totalMin>0?'#1D9E75':'var(--color-text-secondary)'}}>{fmtHrs(totalMin)}</td>
                    </tr>
                  )
                })})
              </tbody>
            </table>
          </div>
        </div>

        {/* Per-showroom breakdown */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:12, marginTop:12 }}>
          {SHOWROOMS.map(sh => {
            const shEmps = emps.filter(e => e.showroom === sh.key && records.some(r=>r.empId===e.empId))
            let totalMin=0, lates=0, leaves=0, present=0
            validWorkDays.forEach(ds => {
              const dayRecs = records.filter(r => r.date === ds)
              shEmps.forEach(emp => {
                const s = deriveStats(emp.empId, dayRecs, emp.showroom, emp.staffType||'showroom')
                if (!s) return
                const hasArrive = dayRecs.some(r=>r.empId===emp.empId&&r.type==='arrive')
                if (!hasArrive) return
                present++
                if (s.workMin) totalMin += s.workMin
                if (s.lateSec > GRACE_SEC) lates++
                if (s.leaveDur > 0) leaves++
              })
            })
            return (
              <div key={sh.key} style={{ ...S.section, padding:16 }}>
                <div style={{ fontSize:13, fontWeight:600, marginBottom:10, color:'var(--color-text-primary)' }}>{sh.icon} {dn(sh.key)}</div>
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  <div style={S.statRow}><span style={{color:'var(--color-text-secondary)',fontSize:12}}>Staff (active)</span><span style={{fontWeight:500}}>{shEmps.length}</span></div>
                  <div style={S.statRow}><span style={{color:'var(--color-text-secondary)',fontSize:12}}>Total check-ins</span><span style={{fontWeight:500,color:'#1D9E75'}}>{present}</span></div>
                  <div style={S.statRow}><span style={{color:'var(--color-text-secondary)',fontSize:12}}>Total hrs</span><span style={{fontWeight:600,color:'#185FA5'}}>{fmtHrs(totalMin)}</span></div>
                  <div style={S.statRow}><span style={{color:'var(--color-text-secondary)',fontSize:12}}>Late incidents</span><span style={{fontWeight:500,color:'#BA7517'}}>{lates}</span></div>
                  <div style={S.statRow}><span style={{color:'var(--color-text-secondary)',fontSize:12}}>Short leaves</span><span style={{fontWeight:500,color:'#185FA5'}}>{leaves}</span></div>
                </div>
              </div>
            )
          })}
        </div>
      </>
    )
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  const S = {
    section:  { background:'var(--color-background-primary)', border:'0.5px solid var(--color-border-tertiary)', borderRadius:'var(--border-radius-lg)', overflow:'hidden', marginBottom:12 },
    secHead:  { padding:'12px 16px', borderBottom:'0.5px solid var(--color-border-tertiary)', display:'flex', alignItems:'center', justifyContent:'space-between' },
    secTitle: { fontSize:13, fontWeight:500, color:'var(--color-text-primary)' },
    secSub:   { fontSize:12, color:'var(--color-text-secondary)' },
    table:    { width:'100%', borderCollapse:'collapse', fontSize:12 },
    th:       { padding:'8px 12px', textAlign:'left', color:'var(--color-text-secondary)', fontWeight:400, borderBottom:'0.5px solid var(--color-border-tertiary)', fontSize:11, textTransform:'uppercase', letterSpacing:'.04em', whiteSpace:'nowrap' },
    td:       { padding:'9px 12px', borderBottom:'0.5px solid var(--color-border-tertiary)', color:'var(--color-text-primary)', verticalAlign:'middle', whiteSpace:'nowrap' },
    tr:       {},
    statRow:  { display:'flex', justifyContent:'space-between', fontSize:12 },
  }

  return (
    <>
      <Head><title>Idealz Analytics</title><meta name="viewport" content="width=device-width,initial-scale=1"/></Head>

      <div style={{ position:'relative', zIndex:1 }}>
        {/* NAV */}
        <nav style={navStyle}>
          <a href="/" style={{ fontFamily:'var(--font-head)', fontSize:'1.1rem', fontWeight:800, letterSpacing:'-0.02em', display:'flex', alignItems:'center', gap:10, color:'var(--text)' }}>
            <div style={{ width:8, height:8, borderRadius:'50%', background:'var(--accent)', boxShadow:'0 0 12px var(--accent)' }}/>
            IDEALZ · ATTEND
          </a>
          <span style={{ fontSize:14, fontWeight:500, color:'var(--color-text-secondary)' }}>Analytics</span>
        </nav>

        <div style={{ padding:24, maxWidth:1200, margin:'0 auto' }}>
          {/* Controls */}
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:16, flexWrap:'wrap' }}>
            {/* View tabs */}
            <div style={{ display:'flex', gap:4, background:'var(--color-background-secondary)', padding:3, borderRadius:8, border:'0.5px solid var(--color-border-tertiary)' }}>
              {['day','week','month'].map(v => (
                <button key={v} onClick={() => setView(v)} style={{ padding:'5px 14px', border:'none', background: view===v ? 'var(--color-background-primary)' : 'transparent', borderRadius:6, fontSize:13, cursor:'pointer', color: view===v ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', fontWeight: view===v ? 500 : 400, ...(view===v ? { border:'0.5px solid var(--color-border-tertiary)' } : {}) }}>
                  {v.charAt(0).toUpperCase()+v.slice(1)}
                </button>
              ))}
            </div>

            {/* Showroom filter */}
            <div style={{ display:'flex', gap:4 }}>
              {[{k:'all',l:'All'},...SHOWROOMS.map(s=>({k:s.key,l:s.key.replace('Idealz ','')}))].map(({k,l}) => (
                <button key={k} onClick={() => setRoom(k)} style={{ padding:'5px 12px', border:'0.5px solid var(--color-border-tertiary)', background: room===k ? 'var(--color-background-info)' : 'var(--color-background-primary)', borderRadius:8, fontSize:12, cursor:'pointer', color: room===k ? 'var(--color-text-info)' : 'var(--color-text-secondary)', fontWeight: room===k ? 500 : 400 }}>{l}</button>
              ))}
            </div>

            {/* Date nav */}
            <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>
              <button onClick={() => navDate(-1)} style={navBtn}>←</button>
              <span style={{ fontSize:13, fontWeight:500, minWidth:200, textAlign:'center', color:'var(--color-text-primary)' }}>{dateLbl()}</span>
              <button onClick={() => navDate(1)} style={navBtn}>→</button>
            </div>
          </div>

          {/* KPIs */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))', gap:10, marginBottom:16 }}>
            {[
              { l:'Present',      v: kpis.present  ?? '—', c:'#1D9E75' },
              { l:'Absent',       v: kpis.absent   ?? '—', c: kpis.absent > 0 ? '#993C1D' : '#1D9E75' },
              { l:'Late arrivals',v: kpis.late     ?? '—', c: kpis.late > 0 ? '#BA7517' : '#1D9E75' },
              { l:'Early exits',  v: kpis.earlyEx  ?? '—', c: kpis.earlyEx > 0 ? '#D85A30' : '#1D9E75' },
              { l:'Short leaves', v: kpis.leaves   ?? '—', c:'#185FA5' },
              { l:'Half days',    v: kpis.halfDays ?? '—', c: kpis.halfDays > 0 ? '#BA7517' : '#1D9E75' },
              { l:'Avg hrs/day',  v: fmtHrs(kpis.avgHrs), c:'var(--color-text-primary)' },
              ...(() => {
                const wh = computeWorkingHrsKPI()
                const diff = wh.diff
                return [
                  { l:'Total hrs worked', v: fmtHrs(wh.totalWorked), c:'#185FA5' },
                  { l: diff>=0 ? 'Overtime' : 'Short hrs',
                    v: diff!==0 ? (diff>0?'+':'-')+fmtHrs(Math.abs(diff)) : '0',
                    c: diff>0 ? '#7C3AED' : diff<0 ? '#D85A30' : '#1D9E75' },
                ]
              })(),
            ].map(k => (
              <div key={k.l} style={{ background:'var(--color-background-secondary)', borderRadius:8, padding:'12px 14px' }}>
                <div style={{ fontSize:11, color:'var(--color-text-secondary)', marginBottom:4, textTransform:'uppercase', letterSpacing:'.04em' }}>{k.l}</div>
                <div style={{ fontSize:22, fontWeight:500, color:k.c }}>{loading ? '…' : k.v}</div>
              </div>
            ))}
          </div>

          {/* Main content */}
          {loading
            ? <div style={{ textAlign:'center', padding:48, color:'var(--color-text-secondary)', fontSize:14 }}>Loading…</div>
            : view === 'day'   ? <DayView/>
            : view === 'week'  ? <WeekView/>
            : <MonthView/>
          }
        </div>
      </div>
    </>
  )
}

const navStyle = { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'18px 32px', borderBottom:'1px solid var(--border)', background:'rgba(10,10,15,0.9)', backdropFilter:'blur(12px)', position:'sticky', top:0, zIndex:100 }
const navBtn = { padding:'5px 10px', border:'0.5px solid var(--color-border-tertiary)', background:'var(--color-background-primary)', borderRadius:8, cursor:'pointer', fontSize:13, color:'var(--color-text-primary)' }
