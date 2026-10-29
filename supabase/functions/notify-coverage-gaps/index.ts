import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { escapeHtml } from '../_shared/html.ts'

// Proactive, state-based check of next week's call schedule for coverage gaps — emails
// admins with lead time to fix things before weekly-email goes out to the practice.
// This checks what's CURRENTLY scheduled, not edit history — it's the server-side
// equivalent of the calendar's red/amber warning colors (dayCoverageClass in index.html:
// missing/self backup on a double-call day, missing bari), plus "no one on call at all,"
// which the calendar doesn't currently flag visually. Expected to be rare — most issues
// should already have been caught via the calendar's own warning colors.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-test-email, x-force-send',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setUTCDate(r.getUTCDate() + n)
  return r
}
function nextMonday(from: Date): Date {
  const dow = from.getUTCDay()
  const daysAhead = dow === 0 ? 1 : 8 - dow
  const d = new Date(from)
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + daysAhead)
  return d
}
function fmtDay(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// The day-of-week that is `n` business days before `dow`, skipping Sat/Sun while counting.
function businessDaysBefore(dow: number, n: number): number {
  let d = dow
  let remaining = n
  while (remaining > 0) {
    d = (d + 6) % 7
    if (d !== 0 && d !== 6) remaining--
  }
  return d
}

type Cell = { oncall_am: string; oncall_pm: string }

// notify-assignment-changes runs daily at 08:00 UTC, so at this function's 07:00 run its
// last_run is normally ~23h old; one missed run makes it ~47h. 26h sits between the two.
// notify-assignment-changes deliberately leaves last_run untouched when a run fails, so a
// stale value covers both "cron didn't fire" and "it keeps erroring".
const NOTIFY_STALE_HOURS = 26

// Emails the office contact (else all admins) every day the change-notification job
// hasn't completed a run, until one does. Independent of the weekly gap check below.
// deno-lint-ignore no-explicit-any
async function alertIfNotifyStale(sb: any, now: Date) {
  const { data: co, error } = await sb.from('company_info')
    .select('assignment_notify_last_run, office_contact_user_id').eq('id', 1).maybeSingle()
  if (error) { console.error(`notify-coverage-gaps: stale-run check could not read company_info: ${error.message}`); return }
  const lastRun = co?.assignment_notify_last_run as string | null | undefined
  if (!lastRun) return // never run yet (first deploy) — nothing to be stale against
  const hoursSince = (now.getTime() - new Date(lastRun).getTime()) / 3_600_000
  if (hoursSince < NOTIFY_STALE_HOURS) return

  const officeUserId = co?.office_contact_user_id as string | null | undefined
  let toEmails: string[] = []
  if (officeUserId) {
    const { data } = await sb.from('profiles').select('email').eq('id', officeUserId).maybeSingle()
    if (data?.email) toEmails = [data.email]
  }
  if (!toEmails.length) {
    const { data } = await sb.from('profiles').select('email').eq('role', 'admin')
    toEmails = (data ?? []).map((p: { email: string }) => p.email).filter(Boolean)
  }
  if (!toEmails.length) { console.warn('notify-coverage-gaps: change notifications are stale but no one to alert'); return }

  const lastRunText = new Date(lastRun).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#37474F;max-width:650px;margin:0 auto;padding:24px">
  <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:4px">Call schedule change notifications are not running</h2>
  <p style="font-size:0.9rem">The daily job that emails staff about changes to their call assignments last completed <strong>${escapeHtml(lastRunText)}</strong> (${Math.floor(hoursSince)} hours ago). It either isn't being triggered or is failing on every run.</p>
  <p style="font-size:0.9rem">Check the <code>notify-assignment-changes</code> logs in the Supabase dashboard. Nothing is lost while it's down — once a run succeeds it reports every change made since the last good run.</p>
  <p style="font-size:0.78rem;color:#90A4AE;margin-top:20px">You'll get this every morning until a run completes.</p>
</body></html>`

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Call Calendar <noreply@ssrounds.com>',
        to: toEmails,
        subject: 'Action needed: call schedule change notifications are not running',
        html,
      }),
    })
    if (!res.ok) console.error(`notify-coverage-gaps: stale-run alert rejected (${res.status}): ${await res.text()}`)
  } catch (e) {
    console.error(`notify-coverage-gaps: stale-run alert failed: ${e}`)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // ── Auth: cron secret (real scheduled run) or admin session (test run) ───
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
  const testEmail = adminOk ? req.headers.get('x-test-email') : null
  if (adminOk && !testEmail) {
    return new Response('x-test-email is required for admin-triggered runs', { status: 400, headers: CORS })
  }
  const isTest = !!testEmail
  const forceSend = isTest || req.headers.get('x-force-send') === '1'

  // Runs on every scheduled invocation, ahead of the weekly gate below, which returns early
  // on all but one day a week. Skipped for manual/forced runs so those can't double-send.
  if (!forceSend) await alertIfNotifyStale(sb, new Date())

  // ── Schedule check (skip unless forced) ───────────────────────────────
  const { data: co } = await sb.from('company_info').select('email_day, admin_alert_last_sent').eq('id', 1).maybeSingle()
  const now = new Date()

  if (!forceSend) {
    if (co?.email_day == null) {
      return new Response('No weekly email schedule configured', { status: 200, headers: CORS })
    }
    const alertDow = businessDaysBefore(co.email_day, 2)
    if (now.getUTCDay() !== alertDow) {
      return new Response('Not alert day', { status: 200, headers: CORS })
    }
    if (co.admin_alert_last_sent) {
      const hoursSince = (now.getTime() - new Date(co.admin_alert_last_sent).getTime()) / 3_600_000
      if (hoursSince < 20) {
        return new Response('Already sent recently', { status: 200, headers: CORS })
      }
    }
  }

  // ── Next week Mon–Sun ──────────────────────────────────────────────────
  const monday = nextMonday(now)
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i))
  const saturday = days[5]

  // ── Staff ──────────────────────────────────────────────────────────────
  const { data: staffRows } = await sb
    .from('staff')
    .select('id, short_name')
    .eq('active', true)
    .order('sort_order')
  if (!staffRows?.length) return new Response('No staff', { status: 200, headers: CORS })
  const staffOrder = staffRows.map(r => r.short_name)
  const staffById: Record<string, string> = Object.fromEntries(staffRows.map(r => [r.id, r.short_name]))

  // ── Assignments for the week (on-call flags only — that's all this needs) ─
  const { data: assignRows } = await sb
    .from('assignments')
    .select('date, person_id, oncall_am, oncall_pm')
    .gte('date', iso(monday))
    .lte('date', iso(saturday))

  const data: Record<string, Record<string, Cell>> = {}
  for (const row of assignRows ?? []) {
    const person = staffById[row.person_id]
    if (!person) continue
    if (!data[row.date]) data[row.date] = {}
    data[row.date][person] = {
      oncall_am: row.oncall_am || 'none', oncall_pm: row.oncall_pm || 'none',
    }
  }
  function getCell(dateIso: string, person: string): Cell {
    return data[dateIso]?.[person] ?? { oncall_am: 'none', oncall_pm: 'none' }
  }

  // ── daily_coverage for the week — trusts the resolved value the app already
  // computes and persists on every save, same convention as weekly-email/ical/
  // notify-assignment-changes. ─────────────────────────────────────────────
  const { data: covRows } = await sb
    .from('daily_coverage')
    .select('date, day_call_id, bari_id')
    .gte('date', iso(monday))
    .lte('date', iso(addDays(monday, 6)))
  const covByDate: Record<string, { day_call_id: string | null; bari_id: string | null }> =
    Object.fromEntries((covRows ?? []).map(r => [r.date, r]))

  // ── Check each day ─────────────────────────────────────────────────────
  type Gap = { date: Date; issue: string; detail: string }
  const gaps: Gap[] = []

  function isOnCallDay(c: Cell, dow: number): boolean {
    if (dow === 6) return c.oncall_am !== 'none'
    if (dow === 0) return c.oncall_pm !== 'none'
    return c.oncall_am !== 'none' || c.oncall_pm !== 'none'
  }
  function isDoubleCallDay(c: Cell, dow: number): boolean {
    if (dow === 6) return c.oncall_am === 'double'
    if (dow === 0) return c.oncall_pm === 'double'
    return c.oncall_am === 'double' || c.oncall_pm === 'double'
  }

  for (const day of days) {
    const dow = day.getUTCDay()
    // Weekend on-call data lives under Saturday's date; daily_coverage uses the real date.
    const dataIso = dow === 0 ? iso(saturday) : iso(day)
    const covIso = iso(day)

    const callPerson = staffOrder.find(p => isOnCallDay(getCell(dataIso, p), dow)) ?? ''
    if (!callPerson) {
      gaps.push({ date: day, issue: 'On call', detail: 'No one is assigned on-call for this day' })
      continue // backup/bari are meaningless with no on-call person at all
    }

    const cov = covByDate[covIso]
    const bariId = cov?.bari_id ?? null
    const bariName = bariId ? staffById[bariId] : null

    if (isDoubleCallDay(getCell(dataIso, callPerson), dow)) {
      const backupId = cov?.day_call_id ?? null
      const backupName = backupId ? staffById[backupId] : null
      if (!backupName) {
        gaps.push({ date: day, issue: 'Backup', detail: 'No backup assigned for this double-call day' })
      } else if (backupName === callPerson) {
        // A distinct bari-backup person covering that day rescues this — they're already
        // effectively available as backup, so it's not a real gap.
        const bariRescue = !!bariName && bariName !== callPerson
        if (!bariRescue) {
          gaps.push({ date: day, issue: 'Backup', detail: `${callPerson} would be backing up themselves` })
        }
      }
    }

    if (!bariName) {
      gaps.push({ date: day, issue: 'Bari', detail: 'No bariatric coverage assigned for this day' })
    }
  }

  if (!gaps.length && !isTest) {
    return new Response(JSON.stringify({ gaps: 0 }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // ── Compose + send ─────────────────────────────────────────────────────
  let toEmails: string[]
  if (isTest) {
    toEmails = [testEmail!]
  } else {
    const { data: adminProfiles } = await sb.from('profiles').select('email').eq('role', 'admin')
    toEmails = (adminProfiles ?? []).map(p => p.email).filter(Boolean)
    if (!toEmails.length) return new Response('No admins found', { status: 200, headers: CORS })
  }

  const testBanner = isTest
    ? `<p style="background:#FFF3E0;color:#E65100;padding:8px 12px;border-radius:4px;font-size:0.85rem">TEST RUN — a real run would go to every admin, not just you.</p>`
    : ''

  const bodyHtml = gaps.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:0.88rem">
        <thead><tr style="background:#F5F7FA">
          <th style="padding:6px 10px;text-align:left">Date</th>
          <th style="padding:6px 10px;text-align:left">Issue</th>
          <th style="padding:6px 10px;text-align:left">Detail</th>
        </tr></thead>
        <tbody>${gaps.map(g => `<tr>
          <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1">${escapeHtml(fmtDay(g.date))}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1">${escapeHtml(g.issue)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1">${escapeHtml(g.detail)}</td>
        </tr>`).join('\n')}</tbody>
      </table>`
    : `<p style="color:#2e7d32">No coverage gaps found for next week.</p>`

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#37474F;max-width:650px;margin:0 auto;padding:24px">
  ${testBanner}
  <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:4px">Coverage Gaps — Next Week</h2>
  <p style="font-size:0.9rem;color:#607D8B;margin-top:0;margin-bottom:16px">
    ${gaps.length ? 'These need a fix before the weekly schedule email goes out.' : 'Checked and clear.'}
  </p>
  ${bodyHtml}
</body></html>`

  const text = [
    gaps.length ? "Coverage gaps for next week — need a fix before the weekly schedule email goes out" : 'No coverage gaps found for next week.',
    '',
    ...gaps.map(g => `${fmtDay(g.date)} — ${g.issue}: ${g.detail}`),
  ].join('\n')

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Call Calendar <noreply@ssrounds.com>',
      to: toEmails,
      subject: `${isTest ? '[TEST] ' : ''}${gaps.length ? "Coverage gaps in next week's call schedule" : 'Coverage check: next week is clear'}`,
      html, text,
    }),
  })

  if (res.ok && !isTest) {
    await sb.from('company_info').update({ admin_alert_last_sent: now.toISOString() }).eq('id', 1)
  }

  return new Response(JSON.stringify({ gaps: gaps.length, sentTo: toEmails.length }), {
    status: res.ok ? 200 : 500, headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})
