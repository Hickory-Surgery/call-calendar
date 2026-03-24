import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Date helpers ───────────────────────────────────────────────────────────

/** ISO date string YYYY-MM-DD */
function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Add n days, returning a new Date */
function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setUTCDate(r.getUTCDate() + n)
  return r
}

/** Monday of next week from a given date */
function nextMonday(from: Date): Date {
  const dow = from.getUTCDay() // 0=Sun … 6=Sat
  const daysAhead = dow === 0 ? 1 : 8 - dow  // Sunday→+1, Mon→+7, …, Fri→+3
  const d = new Date(from)
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + daysAhead)
  return d
}

/** Format date as "Mon Mar 16" */
function fmtDay(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** Format date as "March 16, 2026" */
function fmtLong(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

// ── Main ───────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Authenticate with shared cron secret
  const secret = Deno.env.get('CRON_SECRET')
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response('Unauthorized', { status: 401 })
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // ── Compute next week Mon–Sun ─────────────────────────────────────────────
  const monday = nextMonday(new Date())
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i))
  // days[0]=Mon … days[5]=Sat, days[6]=Sun
  const saturday = days[5]

  // ── Fetch staff ───────────────────────────────────────────────────────────
  const { data: staffRows, error: staffErr } = await sb
    .from('staff')
    .select('id, short_name, display_name, is_bariatric')
    .eq('active', true)
    .order('sort_order')

  if (staffErr || !staffRows?.length) {
    console.error('No staff:', staffErr?.message)
    return new Response('No staff', { status: 200 })
  }

  const staffOrder: string[] = staffRows.map(r => r.short_name)
  const staffById: Record<string, typeof staffRows[number]> = Object.fromEntries(staffRows.map(r => [r.id, r]))
  const bariatric: Record<string, boolean> = Object.fromEntries(staffRows.map(r => [r.short_name, r.is_bariatric]))

  function displayName(shortName: string): string {
    const row = staffRows.find(r => r.short_name === shortName)
    return row?.display_name || shortName || '—'
  }

  // ── Fetch assignments Mon–Sat (weekend stored under Saturday) ─────────────
  const { data: assignRows } = await sb
    .from('assignments')
    .select('date, person_id, am, pm, oncall_am, oncall_pm')
    .gte('date', iso(monday))
    .lte('date', iso(saturday))

  // data[dateIso][shortName] = assignment row
  const data: Record<string, Record<string, { am: string; pm: string; oncall_am: string; oncall_pm: string }>> = {}
  for (const row of assignRows ?? []) {
    const person = staffById[row.person_id]?.short_name
    if (!person) continue
    if (!data[row.date]) data[row.date] = {}
    data[row.date][person] = { am: row.am || '', pm: row.pm || '', oncall_am: row.oncall_am || 'none', oncall_pm: row.oncall_pm || 'none' }
  }

  function getCell(dateIso: string, person: string) {
    return data[dateIso]?.[person] ?? { am: '', pm: '', oncall_am: 'none', oncall_pm: 'none' }
  }

  // ── Fetch bari_call for the week ──────────────────────────────────────────
  const { data: bariRow } = await sb
    .from('bari_call')
    .select('person_id')
    .eq('week_start', iso(monday))
    .maybeSingle()

  const bariCallPerson = bariRow ? (staffById[bariRow.person_id]?.short_name ?? '') : ''

  // ── Compute per-day summaries ─────────────────────────────────────────────
  type DaySummary = { date: Date; nightCall: string; backup: string; bari: string; closed: boolean }
  const summaries: DaySummary[] = []

  const friIso = iso(addDays(saturday, -1)) // Friday before the weekend

  for (const day of days) {
    const dow = day.getUTCDay() // 0=Sun, 6=Sat
    // Weekend data lives under Saturday's date
    const dataIso = dow === 0 ? iso(saturday) : iso(day)

    function isOnCall(c: ReturnType<typeof getCell>): boolean {
      if (dow === 6) return c.oncall_am !== 'none'
      if (dow === 0) return c.oncall_pm !== 'none'
      return c.oncall_am !== 'none' || c.oncall_pm !== 'none'
    }

    function isHosp(c: ReturnType<typeof getCell>): boolean {
      if (dow === 6) return c.am === 'hosp'
      if (dow === 0) return c.pm === 'hosp'
      return c.am === 'hosp' || c.pm === 'hosp'
    }

    function isClosed(c: ReturnType<typeof getCell>): boolean {
      if (dow === 6) return c.am === 'CLOSED'
      if (dow === 0) return c.pm === 'CLOSED'
      return c.am === 'CLOSED'
    }

    // Closed if first staff member is CLOSED (whole-day close)
    const dayClosed = staffOrder.length > 0 && isClosed(getCell(dataIso, staffOrder[0]))

    // Night call: first person with oncall set for this day's slot
    const callPerson = staffOrder.find(p => isOnCall(getCell(dataIso, p))) ?? ''

    // Backup (= day call / HOSP): first person with hosp; weekends fall back to Friday
    let backupPerson = staffOrder.find(p => isHosp(getCell(dataIso, p))) ?? ''
    if (!backupPerson && (dow === 0 || dow === 6)) {
      backupPerson = staffOrder.find(p => {
        const c = getCell(friIso, p)
        return c.am === 'hosp' || c.pm === 'hosp'
      }) ?? ''
    }

    // Bariatric: call person if bari+, else backup if bari+, else dropdown
    const bariPerson = bariatric[callPerson] ? callPerson
      : bariatric[backupPerson] ? backupPerson
      : bariCallPerson

    summaries.push({
      date: day,
      nightCall: callPerson,
      backup: backupPerson,
      bari: bariPerson,
      closed: dayClosed,
    })
  }

  // ── Build email ───────────────────────────────────────────────────────────
  const weekLabel = `Week of ${fmtLong(monday)}`

  const rowsHtml = summaries.map(s => {
    if (s.closed) {
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1;font-weight:500">${fmtDay(s.date)}</td>
        <td colspan="3" style="padding:8px 12px;border-bottom:1px solid #ECEFF1;color:#90A4AE;font-style:italic">CLOSED</td>
      </tr>`
    }
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1;font-weight:500">${fmtDay(s.date)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1">${s.nightCall ? displayName(s.nightCall) : '<span style="color:#B0BEC5">—</span>'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1">${s.backup ? displayName(s.backup) : '<span style="color:#B0BEC5">—</span>'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1">${s.bari ? displayName(s.bari) : '<span style="color:#B0BEC5">—</span>'}</td>
    </tr>`
  }).join('\n')

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#37474F;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:4px">Call Schedule</h2>
  <p style="font-size:0.9rem;color:#607D8B;margin-top:0;margin-bottom:20px">${weekLabel}</p>
  <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
    <thead>
      <tr style="background:#F5F7FA">
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ECEFF1">Day</th>
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ECEFF1">Night Call</th>
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ECEFF1">Day Call / Backup</th>
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ECEFF1">Bariatric</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p style="font-size:0.75rem;color:#90A4AE;margin-top:20px">
    <a href="https://hickory-surgery.github.io/call-calendar/" style="color:#1565C0">View full calendar</a>
  </p>
</body></html>`

  const text = [
    `Call Schedule — ${weekLabel}`,
    '',
    'Day              Night Call    Day Call/Backup  Bariatric',
    '─'.repeat(60),
    ...summaries.map(s => {
      const day = fmtDay(s.date).padEnd(17)
      if (s.closed) return `${day}CLOSED`
      return `${day}${displayName(s.nightCall).padEnd(14)}${displayName(s.backup).padEnd(17)}${displayName(s.bari)}`
    }),
  ].join('\n')

  // ── Fetch admin emails ────────────────────────────────────────────────────
  const { data: adminProfiles } = await sb
    .from('profiles')
    .select('id')
    .eq('role', 'admin')

  if (!adminProfiles?.length) {
    console.log('No admins found')
    return new Response('No admins', { status: 200 })
  }

  const adminEmails: string[] = []
  for (const { id } of adminProfiles) {
    const { data: { user } } = await sb.auth.admin.getUserById(id)
    if (user?.email) adminEmails.push(user.email)
  }

  if (!adminEmails.length) {
    return new Response('No admin emails', { status: 200 })
  }

  // ── Send via Resend ───────────────────────────────────────────────────────
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Call Calendar <onboarding@resend.dev>',
      to: [adminEmails[0]], // resend.dev sandbox: can only send to account owner
      subject: `Call Schedule — ${weekLabel}`,
      html,
      text,
    }),
  })

  const body = await res.json()
  console.log('Resend:', res.status, JSON.stringify(body))

  return new Response(res.ok ? 'OK' : 'Email failed', { status: res.ok ? 200 : 500 })
})
