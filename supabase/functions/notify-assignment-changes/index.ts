import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { escapeHtml } from '../_shared/html.ts'
import { resolveDayCall } from '../_shared/coverage.ts'

// Notifies staff when an on-call/backup/bari assignment involving them changes after
// initial entry — a genuine reassignment or removal, not routine first-time scheduling.
//
// On-call: detected from audit_log (assignments table), incrementally since the last run.
// Backup/bari: detected by diffing the currently-resolved daily_coverage value against a
// snapshot this job maintains itself (daily_coverage has no history/audit trail of its own).
//
// Rule: blank -> value is silent (initial entry). value -> different value, and value ->
// blank (removal), both notify. A same-date/slot loss and gain of the same value are paired
// into one "swapped" event notifying both people; an unpaired loss is flagged as a gap.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-test-email',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function addDay(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function fmtDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function fmtWhen(iso: string | null): string {
  if (!iso) return 'unknown time'
  return new Date(iso).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC'
}

type Cell = { am: string; pm: string; oncall_am: string; oncall_pm: string }
type NotifyEvent = {
  person: string
  date: string
  role: 'On call' | 'Backup' | 'Bari'
  detail: string
  changedBy: string | null
  changedAt: string | null
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

  // ── Staff / account lookups ───────────────────────────────────────────────
  const { data: staffRows } = await sb
    .from('staff')
    .select('id, short_name, user_id, email')
    .eq('active', true)
    .order('sort_order')

  const staffById: Record<string, { id: string; short_name: string; user_id: string | null; email: string | null }> =
    Object.fromEntries((staffRows ?? []).map(r => [r.id, r]))
  const staffByShortName: Record<string, { id: string; short_name: string; user_id: string | null; email: string | null }> =
    Object.fromEntries((staffRows ?? []).map(r => [r.short_name, r]))

  const { data: profileRows } = await sb.from('profiles').select('id, email')
  const emailByUserId: Record<string, string> = Object.fromEntries((profileRows ?? []).map(p => [p.id, p.email]))

  // Linked account takes priority (stays accurate automatically); the manually-entered
  // email is a fallback for staff with no login.
  function emailFor(shortName: string): string | null {
    const row = staffByShortName[shortName]
    if (!row) return null
    if (row.user_id && emailByUserId[row.user_id]) return emailByUserId[row.user_id]
    return row.email ?? null
  }
  function labelForChanger(uid: string | null): string {
    if (!uid) return 'System (automatic recalculation)'
    return emailByUserId[uid] ?? 'an unknown account'
  }

  // ── Time window ────────────────────────────────────────────────────────
  const { data: co } = await sb.from('company_info').select('assignment_notify_last_run').eq('id', 1).maybeSingle()
  const lastRun = co?.assignment_notify_last_run as string | null
  const now = new Date()
  const nowIso = now.toISOString()
  const today = nowIso.slice(0, 10)
  const yesterday = addDay(today, -1)
  // If this has never run before, there's nothing to diff against — bootstrap silently
  // (defaulting the "since" marker to now means the audit_log scan below finds nothing).
  const sinceIso = lastRun ?? nowIso

  const { data: maxRow } = await sb
    .from('assignments')
    .select('date')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle()
  const maxDate = maxRow?.date && maxRow.date > yesterday ? maxRow.date : yesterday

  // ═══════════════════════════════════════════════════════════════════════
  // 1. On-call changes — from audit_log, since last run
  // ═══════════════════════════════════════════════════════════════════════

  const { data: auditRows } = await sb
    .from('audit_log')
    .select('changed_at, changed_by, old_row, new_row')
    .gt('changed_at', sinceIso)
    .order('changed_at')

  type RawTransition = {
    date: string; slot: 'am' | 'pm'; person: string
    from: string; to: string
    changedBy: string | null; changedAt: string
  }
  const rawTransitions: RawTransition[] = []

  for (const row of (auditRows ?? []) as Array<{
    changed_at: string; changed_by: string | null
    old_row: Record<string, unknown> | null; new_row: Record<string, unknown> | null
  }>) {
    const rec = row.new_row ?? row.old_row
    const date = rec?.date as string | undefined
    if (!date || date < yesterday || date > maxDate) continue
    const personId = rec?.person_id as string | undefined
    const person = personId ? staffById[personId]?.short_name : undefined
    if (!person) continue

    const dow = new Date(date + 'T00:00:00Z').getUTCDay()
    const oldAm = (row.old_row?.oncall_am as string | undefined) ?? 'none'
    const newAm = (row.new_row?.oncall_am as string | undefined) ?? 'none'
    const oldPm = (row.old_row?.oncall_pm as string | undefined) ?? 'none'
    const newPm = (row.new_row?.oncall_pm as string | undefined) ?? 'none'

    function pushSlot(slot: 'am' | 'pm', from: string, to: string) {
      if (from === to) return
      // Weekend storage: a Saturday row's pm field represents Sunday.
      const effDate = (dow === 6 && slot === 'pm') ? addDay(date!, 1) : date!
      rawTransitions.push({ date: effDate, slot, person: person!, from, to, changedBy: row.changed_by, changedAt: row.changed_at })
    }
    pushSlot('am', oldAm, newAm)
    pushSlot('pm', oldPm, newPm)
  }

  // Collapse multiple edits to the same (person, date, slot) within this window into a
  // single net transition (earliest "from" -> latest "to"), dropping it entirely if it
  // nets to no change. Otherwise a change-then-revert — or a multi-hop chain, e.g.
  // KP->MC then MC->JH — would replay every intermediate hop (MC would get notified
  // about an assignment they never actually ended up holding) instead of reporting the
  // true before/after for each person.
  const netGroups = new Map<string, RawTransition[]>()
  for (const t of rawTransitions) {
    const key = `${t.person}|${t.date}|${t.slot}`
    if (!netGroups.has(key)) netGroups.set(key, [])
    netGroups.get(key)!.push(t)
  }
  const nettedTransitions: RawTransition[] = []
  for (const group of netGroups.values()) {
    const first = group[0]
    const last = group[group.length - 1]
    if (first.from === last.to) continue
    nettedTransitions.push({
      date: first.date, slot: first.slot, person: first.person,
      from: first.from, to: last.to,
      changedBy: last.changedBy, changedAt: last.changedAt,
    })
  }

  const onCallEvents: NotifyEvent[] = []
  const losses = nettedTransitions.filter(t => t.from !== 'none' && t.to === 'none')
  const gains = nettedTransitions.filter(t => t.from === 'none' && t.to !== 'none')
  const ownChanges = nettedTransitions.filter(t => t.from !== 'none' && t.to !== 'none' && t.from !== t.to)
  const pairedGainIdx = new Set<number>()

  for (const loss of losses) {
    const key = `${loss.date}|${loss.slot}`
    const partnerIdx = gains.findIndex((g, i) =>
      !pairedGainIdx.has(i) && `${g.date}|${g.slot}` === key && g.to === loss.from
    )
    if (partnerIdx !== -1) {
      pairedGainIdx.add(partnerIdx)
      const gain = gains[partnerIdx]
      onCallEvents.push({
        person: loss.person, date: loss.date, role: 'On call',
        detail: `Reassigned to ${gain.person}`,
        changedBy: loss.changedBy, changedAt: loss.changedAt,
      })
      onCallEvents.push({
        person: gain.person, date: gain.date, role: 'On call',
        detail: `Now on call (was ${loss.person})`,
        changedBy: gain.changedBy, changedAt: gain.changedAt,
      })
    } else {
      onCallEvents.push({
        person: loss.person, date: loss.date, role: 'On call',
        detail: `Removed — no replacement assigned, this day is now uncovered`,
        changedBy: loss.changedBy, changedAt: loss.changedAt,
      })
    }
  }
  for (const vc of ownChanges) {
    onCallEvents.push({
      person: vc.person, date: vc.date, role: 'On call',
      detail: `Changed from "${vc.from}" to "${vc.to}"`,
      changedBy: vc.changedBy, changedAt: vc.changedAt,
    })
  }
  // Unpaired gains are silent — ordinary new scheduling, not a change to something existing.

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Backup/bari changes — resolved value diffed against our own snapshot
  // ═══════════════════════════════════════════════════════════════════════

  // Fetches from one day before the window so a Sunday at the window's start can still
  // look back to its Saturday row (weekend storage: Saturday holds both days' data).
  const { data: assignRangeRows } = await sb
    .from('assignments')
    .select('date, person_id, am, pm, oncall_am, oncall_pm')
    .gte('date', addDay(yesterday, -1))
    .lte('date', maxDate)

  const cellData: Record<string, Record<string, Cell>> = {}
  for (const row of assignRangeRows ?? []) {
    const person = staffById[row.person_id]?.short_name
    if (!person) continue
    if (!cellData[row.date]) cellData[row.date] = {}
    cellData[row.date][person] = {
      am: row.am || '', pm: row.pm || '',
      oncall_am: row.oncall_am || 'none', oncall_pm: row.oncall_pm || 'none',
    }
  }
  function getCell(dateIso: string, person: string): Cell {
    return cellData[dateIso]?.[person] ?? { am: '', pm: '', oncall_am: 'none', oncall_pm: 'none' }
  }

  const { data: covRows } = await sb
    .from('daily_coverage')
    .select('date, day_call_id, bari_id, updated_by, updated_at')
    .gte('date', yesterday)
    .lte('date', maxDate)
  const covByDate: Record<string, { day_call_id: string | null; bari_id: string | null; updated_by: string | null; updated_at: string | null }> =
    Object.fromEntries((covRows ?? []).map(r => [r.date, r]))

  const { data: snapRows } = await sb
    .from('assignment_notify_snapshot')
    .select('date, backup_id, bari_id')
    .gte('date', yesterday)
    .lte('date', maxDate)
  const snapByDate: Record<string, { backup_id: string | null; bari_id: string | null }> =
    Object.fromEntries((snapRows ?? []).map(r => [r.date, r]))

  const coverageEvents: NotifyEvent[] = []
  const newSnapshotRows: Array<{ date: string; backup_id: string | null; bari_id: string | null; updated_at: string }> = []

  function diffRole(role: 'Backup' | 'Bari', date: string, prevId: string | null, newId: string | null, changedBy: string | null, changedAt: string | null) {
    if (prevId === newId) return
    // Resolve against active staff only — a snapshot can reference someone since
    // deactivated. Notify whichever side still resolves; skip the side that doesn't
    // rather than pushing an unresolvable person (which would crash the grouping below).
    const prevName = prevId ? staffById[prevId]?.short_name ?? null : null
    const newName = newId ? staffById[newId]?.short_name ?? null : null
    if (!prevId && newId) return // blank -> value: silent, initial entry
    if (prevId && !newId) {
      if (!prevName) return
      coverageEvents.push({
        person: prevName, date, role,
        detail: `Removed — no replacement assigned, this day is now uncovered`,
        changedBy, changedAt,
      })
    } else if (prevId && newId && prevId !== newId) {
      if (prevName) coverageEvents.push({
        person: prevName, date, role, detail: `Reassigned to ${newName ?? 'someone else'}`,
        changedBy, changedAt,
      })
      if (newName) coverageEvents.push({
        person: newName, date, role, detail: `Now assigned (was ${prevName ?? 'someone else'})`,
        changedBy, changedAt,
      })
    }
  }

  for (let d = yesterday; d <= maxDate; d = addDay(d, 1)) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay()
    const dataIso = dow === 0 ? addDay(d, -1) : d

    function isClosed(c: Cell): boolean {
      if (dow === 6) return c.am === 'CLOSED'
      if (dow === 0) return c.pm === 'CLOSED'
      return c.am === 'CLOSED'
    }
    function isOnCall(c: Cell): boolean {
      if (dow === 6) return c.oncall_am !== 'none'
      if (dow === 0) return c.oncall_pm !== 'none'
      return c.oncall_am !== 'none' || c.oncall_pm !== 'none'
    }
    const dayClosed = !!staffRows?.length && isClosed(getCell(dataIso, staffRows[0].short_name))
    const callPerson = (staffRows ?? []).map(r => r.short_name).find(p => isOnCall(getCell(dataIso, p))) ?? ''

    // Backup/bari are meaningful on weekends too (Friday-fallback algorithm, and the
    // Coverage Override modal supports Sat/Sun overrides directly) — unlike weekly-email's
    // "Weekday Call" column, this isn't gated on isWeekend.
    const cov = covByDate[d]
    const rawBackupShort = cov?.day_call_id ? staffById[cov.day_call_id]?.short_name ?? '' : ''
    const resolvedBackupShort = resolveDayCall(cov?.day_call_id ? rawBackupShort : null, dayClosed, callPerson)
    const resolvedBackupId = resolvedBackupShort ? staffByShortName[resolvedBackupShort]?.id ?? null : null

    const snap = snapByDate[d]
    diffRole('Backup', d, snap?.backup_id ?? null, resolvedBackupId, cov?.updated_by ?? null, cov?.updated_at ?? null)
    diffRole('Bari', d, snap?.bari_id ?? null, cov?.bari_id ?? null, cov?.updated_by ?? null, cov?.updated_at ?? null)

    newSnapshotRows.push({ date: d, backup_id: resolvedBackupId, bari_id: cov?.bari_id ?? null, updated_at: nowIso })
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Compose + send, one digest per affected person
  // ═══════════════════════════════════════════════════════════════════════

  // A weekday's on-call is two independent slots (am/pm) usually moved together by the
  // whole-day drag, so the same swap can produce two events that read identically to the
  // recipient (e.g. am and pm both "Now on call (was MC)") — collapse those into one line.
  const seenEventKeys = new Set<string>()
  const allEvents = [...onCallEvents, ...coverageEvents].filter(ev => {
    const key = `${ev.person}|${ev.date}|${ev.role}|${ev.detail}|${ev.changedBy ?? ''}`
    if (seenEventKeys.has(key)) return false
    seenEventKeys.add(key)
    return true
  })
  const byPerson = new Map<string, NotifyEvent[]>()
  for (const ev of allEvents) {
    if (!byPerson.has(ev.person)) byPerson.set(ev.person, [])
    byPerson.get(ev.person)!.push(ev)
  }

  const results: Array<{ person: string; email: string | null; sent: boolean }> = []

  for (const [person, events] of byPerson) {
    const toEmail = isTest ? testEmail : emailFor(person)
    if (!toEmail) {
      results.push({ person, email: null, sent: false })
      continue
    }
    events.sort((a, b) => a.date.localeCompare(b.date))

    const rowsHtml = events.map(ev => `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1">${escapeHtml(fmtDay(ev.date))}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1">${escapeHtml(ev.role)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1">${escapeHtml(ev.detail)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1;color:#607D8B;font-size:0.82rem">${escapeHtml(labelForChanger(ev.changedBy))}<br>${escapeHtml(fmtWhen(ev.changedAt))}</td>
    </tr>`).join('\n')

    const testBanner = isTest
      ? `<p style="background:#FFF3E0;color:#E65100;padding:8px 12px;border-radius:4px;font-size:0.85rem">TEST RUN — this would actually have been sent to <strong>${escapeHtml(person)}</strong>${emailFor(person) ? ` (${escapeHtml(emailFor(person)!)})` : ' (no linked account/email on file)'}.</p>`
      : ''

    const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#37474F;max-width:650px;margin:0 auto;padding:24px">
  ${testBanner}
  <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:4px">Call Schedule Changes</h2>
  <p style="font-size:0.9rem;color:#607D8B;margin-top:0;margin-bottom:16px">
    The following changes were made to assignments involving you.
  </p>
  <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
    <thead><tr style="background:#F5F7FA">
      <th style="padding:6px 10px;text-align:left">Date</th>
      <th style="padding:6px 10px;text-align:left">Role</th>
      <th style="padding:6px 10px;text-align:left">Change</th>
      <th style="padding:6px 10px;text-align:left">Made by</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p style="font-size:0.78rem;color:#90A4AE;margin-top:20px">
    If any of this looks wrong, contact whoever made the change, or a scheduler/admin.
  </p>
</body></html>`

    const text = [
      `Call schedule changes for ${person}`,
      '',
      ...events.map(ev => `${fmtDay(ev.date)} — ${ev.role}: ${ev.detail} (by ${labelForChanger(ev.changedBy)} at ${fmtWhen(ev.changedAt)})`),
    ].join('\n')

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Call Calendar <noreply@ssrounds.com>',
        to: toEmail,
        subject: `${isTest ? '[TEST] ' : ''}Call schedule change${events.length > 1 ? 's' : ''} affecting you`,
        html, text,
      }),
    })
    results.push({ person, email: toEmail, sent: res.ok })
  }

  // ── Persist state (skipped entirely for test runs) ────────────────────
  if (!isTest) {
    if (newSnapshotRows.length) {
      await sb.from('assignment_notify_snapshot').upsert(newSnapshotRows)
    }
    await sb.from('company_info').update({ assignment_notify_last_run: nowIso }).eq('id', 1)
  }

  return new Response(JSON.stringify({
    window: { from: yesterday, to: maxDate },
    onCallEvents: onCallEvents.length,
    coverageEvents: coverageEvents.length,
    notified: results,
  }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
})
