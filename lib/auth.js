// ── Session helpers ───────────────────────────────────────────────────────────
export function getSession() {
  if (typeof window === 'undefined') return null
  try {
    const s = localStorage.getItem('idealz_session')
    if (!s) return null
    const session = JSON.parse(s)
    // Session expires after 12 hours.
    // A session with no loginTime is treated as expired rather than eternal:
    // Date.now() - undefined is NaN, and NaN > anything is false, so without
    // this check a malformed or legacy session would never time out.
    if (!session.loginTime || Date.now() - session.loginTime > 12 * 60 * 60 * 1000) {
      localStorage.removeItem('idealz_session')
      return null
    }
    return session
  } catch { return null }
}

export function saveSession(employee) {
  const session = {
    empId:     employee.empId,
    name:      employee.name,
    showroom:  employee.showroom,
    staffType: employee.staffType || 'showroom',
    role:      employee.role || 'employee',
    color:     employee.color,
    id:        employee.id,
    loginTime: Date.now(),
  }
  localStorage.setItem('idealz_session', JSON.stringify(session))
  return session
}

export function clearSession() {
  localStorage.removeItem('idealz_session')
}

// ── Role checks ───────────────────────────────────────────────────────────────
// Roles: 'employee' | 'manager' | 'admin'
//
//                   Employee   Manager            Admin / HR
//   Check In/Out       yes       yes                 yes
//   Reports            no        yes (own branch)    yes (all branches)
//   Admin panel        no        no                  yes
//   Analytics          no        no                  yes

export function canViewReports(session) {
  return session?.role === 'manager' || session?.role === 'admin'
}

export function canViewAllShowrooms(session) {
  return session?.role === 'admin'
}

export function canManageEmployees(session) {
  return session?.role === 'admin'
}

// Admin only. The /analytics page enforces this itself as well, and redirects
// anyone else back to the attendance page before it loads any data.
export function canViewAnalytics(session) {
  return session?.role === 'admin'
}

// Manager can only see their own showroom
export function getAllowedShowroom(session) {
  if (session?.role === 'admin') return null // null = all showrooms
  return session?.showroom
}
