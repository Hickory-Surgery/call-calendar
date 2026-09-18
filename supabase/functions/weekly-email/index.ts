import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { escapeHtml } from '../_shared/html.ts'
import { resolveDayCall } from '../_shared/coverage.ts'

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

// Only the browser (admin test-send) is a cross-origin caller — pg_cron's server-to-server
// call isn't subject to CORS. Headers list covers both the auth token and this function's
// custom headers.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-test-email, x-force-send, x-subject-prefix',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS })
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Authenticate: either the shared cron secret (pg_cron's scheduled call), or an
  // admin's own session (manual "send test email" from Settings). The admin path is
  // restricted to test sends only — it can never trigger the real recipient list.
  const secret = Deno.env.get('CRON_SECRET')
  const cronOk = !!secret && req.headers.get('x-cron-secret') === secret

  let adminOk = false
  if (!cronOk) {
    const authHeader = req.headers.get('Authorization') ?? ''
    if (authHeader.startsWith('Bearer ')) {
      const { data: { user } } = await sb.auth.getUser(authHeader.slice(7))
      if (user) {
        const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle()
        adminOk = profile?.role === 'admin'
      }
    }
  }

  if (!cronOk && !adminOk) {
    return new Response('Unauthorized', { status: 401, headers: CORS })
  }
  if (adminOk && !req.headers.get('x-test-email')) {
    return new Response('x-test-email is required for admin-triggered sends', { status: 400, headers: CORS })
  }

  // ── Fetch company info ────────────────────────────────────────────────────
  const { data: co } = await sb.from('company_info').select('*').eq('id', 1).maybeSingle()

  // ── Schedule check (skip if not the right day/time window) ───────────────
  const now = new Date()
  const forceSend = req.headers.get('x-force-send') === '1'
  if (!forceSend) {
    // If no schedule configured, refuse to send (must force)
    if (co?.email_day == null || !co?.email_time) {
      console.log('No schedule configured — set email_day and email_time in Practice settings')
      return new Response('No schedule configured', { status: 200, headers: CORS })
    }
    // Check day of week (UTC)
    if (now.getUTCDay() !== co.email_day) {
      console.log(`Not send day (today=${now.getUTCDay()}, configured=${co.email_day})`)
      return new Response('Not send day', { status: 200, headers: CORS })
    }
    // Check time window: within 29 minutes of configured time (tolerates 30-min cron intervals)
    const [schedHH, schedMM] = (co.email_time as string).slice(0, 5).split(':').map(Number)
    const schedMinutes = schedHH * 60 + schedMM
    const nowMinutes   = now.getUTCHours() * 60 + now.getUTCMinutes()
    if (nowMinutes < schedMinutes || nowMinutes >= schedMinutes + 29) {
      console.log(`Outside time window (now=${nowMinutes}, sched=${schedMinutes})`)
      return new Response('Outside time window', { status: 200, headers: CORS })
    }
    // Deduplication: skip if already sent within the last 6 hours
    if (co.email_last_sent) {
      const lastSent = new Date(co.email_last_sent)
      const hoursSince = (now.getTime() - lastSent.getTime()) / 3_600_000
      if (hoursSince < 6) {
        console.log(`Already sent ${hoursSince.toFixed(1)}h ago — skipping`)
        return new Response('Already sent recently', { status: 200, headers: CORS })
      }
    }
  }

  // ── Compute next week Mon–Sun ─────────────────────────────────────────────
  const monday = nextMonday(now)
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i))
  // days[0]=Mon … days[5]=Sat, days[6]=Sun
  const saturday = days[5]

  // ── Fetch staff ───────────────────────────────────────────────────────────
  const { data: staffRows, error: staffErr } = await sb
    .from('staff')
    .select('id, short_name, display_name')
    .eq('active', true)
    .order('sort_order')

  if (staffErr || !staffRows?.length) {
    console.error('No staff:', staffErr?.message)
    return new Response('No staff', { status: 200, headers: CORS })
  }

  const staffOrder: string[] = staffRows.map(r => r.short_name)
  const staffById: Record<string, typeof staffRows[number]> = Object.fromEntries(staffRows.map(r => [r.id, r]))

  function displayName(shortName: string): string {
    const row = staffRows.find(r => r.short_name === shortName)
    return row?.display_name || shortName || '—'
  }

  // ── Fetch assignments Mon–Sat (weekend stored under Saturday) — needed only
  // for on-call and CLOSED-day detection; day-call/bari come from daily_coverage below.
  const { data: assignRows } = await sb
    .from('assignments')
    .select('date, person_id, am, pm, oncall_am, oncall_pm')
    .gte('date', iso(monday))
    .lte('date', iso(saturday))

  type Cell = { am: string; pm: string; oncall_am: string; oncall_pm: string }

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
    }
  }

  function getCell(dateIso: string, person: string): Cell {
    return data[dateIso]?.[person] ?? { am: '', pm: '', oncall_am: 'none', oncall_pm: 'none' }
  }

  // ── Fetch daily_coverage Mon–Sun ─────────────────────────────────────────
  // The app computes and persists day_call_id/bari_id (override or algorithm result) on
  // every assignment save, so these are already the resolved values — no need to
  // re-derive them here. See supabase/functions/_shared/coverage.ts.
  const { data: covRows } = await sb
    .from('daily_coverage')
    .select('date, day_call_id, bari_id')
    .gte('date', iso(monday))
    .lte('date', iso(addDays(monday, 6)))

  type Coverage = { dayCall: string | null; bari: string | null }
  const coverage: Record<string, Coverage> = {}
  for (const row of covRows ?? []) {
    coverage[row.date] = {
      dayCall: row.day_call_id !== null ? (staffById[row.day_call_id]?.short_name ?? '') : null,
      bari:    row.bari_id    !== null ? (staffById[row.bari_id]?.short_name    ?? '') : null,
    }
  }

  // ── Compute per-day summaries ─────────────────────────────────────────────
  type DaySummary = { date: Date; onCall: string; weekdayCall: string; bari: string; closed: boolean }
  const summaries: DaySummary[] = []

  for (const day of days) {
    const dow = day.getUTCDay() // 0=Sun, 6=Sat
    const isWeekend = dow === 0 || dow === 6
    // Weekend data in assignments lives under Saturday's date
    const dataIso = dow === 0 ? iso(saturday) : iso(day)
    // daily_coverage uses the actual calendar date for each day
    const covIso = iso(day)

    function isOnCall(c: Cell): boolean {
      if (dow === 6) return c.oncall_am !== 'none'
      if (dow === 0) return c.oncall_pm !== 'none'
      return c.oncall_am !== 'none' || c.oncall_pm !== 'none'
    }

    function isClosed(c: Cell): boolean {
      if (dow === 6) return c.am === 'CLOSED'
      if (dow === 0) return c.pm === 'CLOSED'
      return c.am === 'CLOSED'
    }

    // Closed if first staff member is CLOSED (whole-day close)
    const dayClosed = staffOrder.length > 0 && isClosed(getCell(dataIso, staffOrder[0]))

    // On call: first person with oncall set for this day's slot
    const callPerson = staffOrder.find(p => isOnCall(getCell(dataIso, p))) ?? ''

    // Weekday call: override/algorithm result from daily_coverage; on a CLOSED day with
    // nothing stored, fall back to the on-call person (holiday arrangement). Blank on weekends.
    const weekdayCall = isWeekend ? '' : resolveDayCall(coverage[covIso]?.dayCall, dayClosed, callPerson)

    summaries.push({
      date: day,
      onCall: callPerson,
      weekdayCall,
      bari: coverage[covIso]?.bari ?? '',
      closed: dayClosed,
    })
  }

  // ── Build email ───────────────────────────────────────────────────────────
  const weekLabel = `Week of ${fmtLong(monday)}`
  const subjectPrefix = req.headers.get('x-subject-prefix') ?? ''
  const subject = `${subjectPrefix}Call Schedule — ${weekLabel}`

  function cell(name: string): string {
    return name ? displayName(name) : '<span style="color:#B0BEC5">—</span>'
  }

  const rowsHtml = summaries.map(s => {
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1;font-weight:500">${fmtDay(s.date)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1">${cell(s.onCall)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1">${cell(s.weekdayCall)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #ECEFF1">${cell(s.bari)}</td>
    </tr>`
  }).join('\n')

  // Company header block (only rendered when data is present)
  const logoHtml = co?.logo_url
    ? `<img src="${escapeHtml(co.logo_url)}" alt="${escapeHtml(co?.name ?? '')}" style="max-height:56px;max-width:180px;object-fit:contain;display:block;margin-bottom:8px">`
    : ''
  const practiceHtml = co?.name
    ? `<div style="margin-bottom:20px;padding-bottom:16px;border-bottom:2px solid #ECEFF1">
        ${logoHtml}
        <div style="font-size:1rem;font-weight:700;color:#37474F">${escapeHtml(co.name)}</div>
        ${co?.address  ? `<div style="font-size:0.8rem;color:#607D8B;white-space:pre-line">${escapeHtml(co.address)}</div>` : ''}
        <div style="font-size:0.8rem;color:#607D8B;margin-top:4px">
          ${co?.phone ? `Phone: ${escapeHtml(co.phone)}` : ''}${co?.phone && co?.fax ? '&ensp;·&ensp;' : ''}${co?.fax ? `Fax: ${escapeHtml(co.fax)}` : ''}
        </div>
      </div>`
    : ''

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#37474F;max-width:650px;margin:0 auto;padding:24px">
  ${practiceHtml}
  <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:4px">Call Schedule</h2>
  <p style="font-size:0.9rem;color:#607D8B;margin-top:0;margin-bottom:20px">${weekLabel}</p>
  <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
    <thead>
      <tr style="background:#F5F7FA">
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ECEFF1">Day</th>
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ECEFF1">On Call<br><span style="font-weight:400;font-size:0.78rem;color:#90A4AE">Nights &amp; weekends</span></th>
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ECEFF1">Weekday Call<br><span style="font-weight:400;font-size:0.78rem;color:#90A4AE">7am to 5pm</span></th>
        <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #ECEFF1">Bariatric</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p style="font-size:0.75rem;color:#90A4AE;margin-top:20px">
    <a href="https://hickory-surgery.github.io/call-calendar/" style="color:#1565C0">View full calendar</a>
    ${co?.office_manager ? `&ensp;·&ensp;Office Mgr: ${escapeHtml(co.office_manager)}` : ''}
    ${co?.scheduling_coordinator ? `&ensp;·&ensp;Scheduling: ${escapeHtml(co.scheduling_coordinator)}` : ''}
  </p>
</body></html>`

  const text = [
    subject,
    '',
    'Day              On Call       Weekday Call  Bariatric',
    '─'.repeat(56),
    ...summaries.map(s => {
      const day = fmtDay(s.date).padEnd(17)
      const dn = (n: string) => (n ? displayName(n) : '—')
      return `${day}${dn(s.onCall).padEnd(14)}${dn(s.weekdayCall).padEnd(14)}${dn(s.bari)}`
    }),
  ].join('\n')

  // ── Fetch email recipients ────────────────────────────────────────────────
  const testEmail = req.headers.get('x-test-email')

  let recipientEmails: string[]
  if (testEmail) {
    recipientEmails = [testEmail]
    console.log('Test mode — sending only to:', testEmail)
  } else {
    const { data: recipientRows } = await sb
      .from('email_recipients')
      .select('email')
      .order('created_at')

    if (!recipientRows?.length) {
      console.log('No email recipients configured')
      return new Response('No recipients', { status: 200, headers: CORS })
    }

    recipientEmails = recipientRows.map(r => r.email)
    console.log('Sending to:', recipientEmails)
  }

  // ── Send via Resend ───────────────────────────────────────────────────────
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Call Calendar <noreply@ssrounds.com>',
      to: 'noreply@ssrounds.com',
      bcc: recipientEmails,
      subject,
      html,
      text,
    }),
  })

  const body = await res.json()
  console.log('Resend:', res.status, JSON.stringify(body))

  if (res.ok && !testEmail) {
    await sb.from('company_info').update({ email_last_sent: now.toISOString() }).eq('id', 1)
  }

  return new Response(res.ok ? 'OK' : 'Email failed', { status: res.ok ? 200 : 500, headers: CORS })
})
