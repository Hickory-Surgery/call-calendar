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
    .select('date, person_id, am, pm, oncall_am, oncall_pm, exception')
    .gte('date', iso(monday))
    .lte('date', iso(saturday))

  type Cell = { am: string; pm: string; oncall_am: string; oncall_pm: string; exception: boolean }

  // data[dateIso][shortName] = cell
  const data: Record<string, Record<string, Cell>> = {}
  for (const row of assignRows ?? []) {
    const person = staffById[row.person_id]?.short_name
    if (!person) continue
    if (!data[row.date]) data[row.date] = {}
    data[row.date][person] = {
      am: row.am || '',
      pm: row.pm || '',
      oncall_am: row.oncall_am || 'none',
      oncall_pm: row.oncall_pm || 'none',
      exception: row.exception ?? false,
    }
  }

  function getCell(dateIso: string, person: string): Cell {
    return data[dateIso]?.[person] ?? { am: '', pm: '', oncall_am: 'none', oncall_pm: 'none', exception: false }
  }

  // ── Fetch bari_call for the week ──────────────────────────────────────────
  const { data: bariRow } = await sb
    .from('bari_call')
    .select('person_id')
    .eq('week_start', iso(monday))
    .maybeSingle()

  const bariCallPerson = bariRow ? (staffById[bariRow.person_id]?.short_name ?? '') : ''

  // ── Fetch coverage overrides Mon–Sat ──────────────────────────────────────
  const { data: ovRows } = await sb
    .from('coverage_overrides')
    .select('date, backup_id, bari_id')
    .gte('date', iso(monday))
    .lte('date', iso(saturday))

  // overrides[dateIso] = { backup: shortName|'', bari: shortName|'' }
  // null means "no override for this field"; '' means explicitly cleared
  type Override = { backup: string | null; bari: string | null }
  const overrides: Record<string, Override> = {}
  for (const row of ovRows ?? []) {
    overrides[row.date] = {
      backup: row.backup_id ? (staffById[row.backup_id]?.short_name ?? '') : null,
      bari:   row.bari_id   ? (staffById[row.bari_id]?.short_name   ?? '') : null,
    }
  }

  // ── Compute per-day summaries ─────────────────────────────────────────────
  type DaySummary = { date: Date; nightCall: string; dayCall: string; backup: string; bari: string; closed: boolean }
  const summaries: DaySummary[] = []

  const friIso = iso(addDays(saturday, -1)) // Friday before the weekend

  for (const day of days) {
    const dow = day.getUTCDay() // 0=Sun, 6=Sat
    // Weekend data lives under Saturday's date; overrides follow the same convention
    const dataIso = dow === 0 ? iso(saturday) : iso(day)

    function isOnCall(c: Cell): boolean {
      if (dow === 6) return c.oncall_am !== 'none'
      if (dow === 0) return c.oncall_pm !== 'none'
      return c.oncall_am !== 'none' || c.oncall_pm !== 'none'
    }

    function isHosp(c: Cell): boolean {
      if (dow === 6) return c.am === 'hosp'
      if (dow === 0) return c.pm === 'hosp'
      return c.am === 'hosp' || c.pm === 'hosp'
    }

    function isClosed(c: Cell): boolean {
      if (dow === 6) return c.am === 'CLOSED'
      if (dow === 0) return c.pm === 'CLOSED'
      return c.am === 'CLOSED'
    }

    // Closed if first staff member is CLOSED (whole-day close)
    const dayClosed = staffOrder.length > 0 && isClosed(getCell(dataIso, staffOrder[0]))

    // Night call: first person with oncall set for this day's slot
    const callPerson = staffOrder.find(p => isOnCall(getCell(dataIso, p))) ?? ''

    // Backup: exception person if present, else first HOSP; weekends fall back to Friday
    const exceptionPerson = staffOrder.find(p => getCell(dataIso, p).exception) ?? ''
    let backupPerson = exceptionPerson || (staffOrder.find(p => isHosp(getCell(dataIso, p))) ?? '')
    if (!backupPerson && (dow === 0 || dow === 6)) {
      backupPerson = staffOrder.find(p => {
        const c = getCell(friIso, p)
        return c.am === 'hosp' || c.pm === 'hosp'
      }) ?? ''
    }

    // Apply backup override (override wins unless exception person present)
    const ov = overrides[dataIso]
    if (!exceptionPerson && ov?.backup !== null && ov?.backup !== undefined) {
      backupPerson = ov.backup
    }

    const dayCallPerson = exceptionPerson || backupPerson

    // Bariatric: call person if bari+, else backup if bari+, else dropdown
    let bariPerson = bariatric[callPerson] ? callPerson
      : bariatric[backupPerson] ? backupPerson
      : bariCallPerson

    // Apply bari override
    if (ov?.bari !== null && ov?.bari !== undefined) {
      bariPerson = ov.bari
    }

    summaries.push({
      date: day,
      nightCall: callPerson,
      dayCall: dayCallPerson,
      backup: backupPerson,
      bari: bariPerson,
      closed: dayClosed,
    })
  }

  // ── Build email ───────────────────────────────────────────────────────────
  const weekLabel = `Week of ${fmtLong(monday)}`

  function cell(name: string): string {
    return name ? displayName(name) : '<span style="color:#B0BEC5">—</span>'
  }

  const rowsHtml = summaries.map(s => {
    if (s.closed) {
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1;font-weight:500">${fmtDay(s.date)}</td>
        <td colspan="4" style="padding:8px 12px;border-bottom:1px solid #ECEFF1;color:#90A4AE;font-style:italic">CLOSED</td>
      </tr>`
    }
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1;font-weight:500">${fmtDay(s.date)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1">${cell(s.nightCall)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1">${cell(s.dayCall)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1">${cell(s.backup)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1">${cell(s.bari)}</td>
    </tr>`
  }).join('\n')

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#37474F;max-width:650px;margin:0 auto;padding:24px">
  <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:4px">Call Schedule</h2>
  <p style="font-size:0.9rem;color:#607D8B;margin-top:0;margin-bottom:20px">${weekLabel}</p>
  <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
    <thead>
      <tr style="background:#F5F7FA">
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ECEFF1">Day</th>
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ECEFF1">Night Call</th>
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ECEFF1">Day Call</th>
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ECEFF1">Backup</th>
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
    'Day              Night Call    Day Call      Backup        Bariatric',
    '─'.repeat(70),
    ...summaries.map(s => {
      const day = fmtDay(s.date).padEnd(17)
      if (s.closed) return `${day}CLOSED`
      const dn = (n: string) => (n ? displayName(n) : '—')
      return `${day}${dn(s.nightCall).padEnd(14)}${dn(s.dayCall).padEnd(14)}${dn(s.backup).padEnd(14)}${dn(s.bari)}`
    }),
  ].join('\n')

  // ── Fetch email recipients ────────────────────────────────────────────────
  const { data: recipientRows } = await sb
    .from('email_recipients')
    .select('email')
    .order('created_at')

  if (!recipientRows?.length) {
    console.log('No email recipients configured')
    return new Response('No recipients', { status: 200 })
  }

  const recipientEmails = recipientRows.map(r => r.email)
  console.log('Sending to:', recipientEmails)

  // ── Send via Resend ───────────────────────────────────────────────────────
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Call Calendar <noreply@ssrounds.com>',
      to: recipientEmails,
      subject: `Call Schedule — ${weekLabel}`,
      html,
      text,
    }),
  })

  const body = await res.json()
  console.log('Resend:', res.status, JSON.stringify(body))

  return new Response(res.ok ? 'OK' : 'Email failed', { status: res.ok ? 200 : 500 })
})
