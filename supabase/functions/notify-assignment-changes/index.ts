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
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

type Cell = { am: string; pm: string; oncall_am: string; oncall_pm: string; exception: boolean }
type NotifyEvent = {
  person: string
  date: string
  role: 'On call' | 'Backup' | 'Bari' | 'Day call (exception)'
  from: string
  to: string
  note?: string
  changedBy: string | null
  changedAt: string | null
}

const UNCOVERED = { to: 'Nobody', note: 'Needs coverage!' }

function levelLabel(v: string): string {
  return v === 'single' ? 'Single' : v === 'double' ? 'Double' : v === 'none' ? 'None' : v
}

// A failed read must abort the run, not look like "no data": the run would otherwise
// advance last_run and the snapshot past changes it never saw, losing them for good.
// Aborting leaves state untouched, so the next run re-scans the same window — and the
// stale last_run is what notify-coverage-gaps' health check alerts on.
// deno-lint-ignore no-explicit-any
function check<T>(what: string, res: { data: T | null; error: any }): T | null {
  if (res.error) throw new Error(`${what}: ${res.error.message ?? res.error}`)
  return res.data
}

// PostgREST caps a response at 1000 rows; a bulk month entry (audit_log) or a long
// schedule horizon (assignments) can exceed that, and a silently truncated read is the
// same data-loss as a failed one.
const PAGE = 1000
// deno-lint-ignore no-explicit-any
async function fetchAll<T>(what: string, page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const rows = check(what, await page(from, from + PAGE - 1)) ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

Deno.serve(async (req) => {
  try {
    return await handle(req)
  } catch (e) {
    console.error(`notify-assignment-changes: run aborted, state not advanced: ${e}`)
    return new Response(`Run aborted: ${e}`, { status: 500, headers: CORS })
  }
})

async function handle(req: Request): Promise<Response> {
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
  const staffRows = check('staff', await sb
    .from('staff')
    .select('id, short_name, user_id, email, is_surgeon')
    .eq('active', true)
    .order('sort_order'))

  const staffById: Record<string, { id: string; short_name: string; user_id: string | null; email: string | null; is_surgeon: boolean | null }> =
    Object.fromEntries((staffRows ?? []).map(r => [r.id, r]))
  const staffByShortName: Record<string, { id: string; short_name: string; user_id: string | null; email: string | null; is_surgeon: boolean | null }> =
    Object.fromEntries((staffRows ?? []).map(r => [r.short_name, r]))

  const profileRows = check('profiles', await sb.from('profiles').select('id, email'))
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
  const co = check<{ assignment_notify_last_run: string | null; office_contact_user_id: string | null }>('company_info', await sb.from('company_info').select('assignment_notify_last_run, office_contact_user_id').eq('id', 1).maybeSingle())
  const lastRun = co?.assignment_notify_last_run as string | null
  const now = new Date()
  const nowIso = now.toISOString()
  const today = nowIso.slice(0, 10)
  const yesterday = addDay(today, -1)
  // If this has never run before, there's nothing to diff against — bootstrap silently
  // (defaulting the "since" marker to now means the audit_log scan below finds nothing).
  const sinceIso = lastRun ?? nowIso

  const maxRow = check<{ date: string }>('assignments max date', await sb
    .from('assignments')
    .select('date')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle())
  const maxDate = maxRow?.date && maxRow.date > yesterday ? maxRow.date : yesterday

  // ═══════════════════════════════════════════════════════════════════════
  // 1. On-call changes — from audit_log, since last run
  // ═══════════════════════════════════════════════════════════════════════

  // Upper-bounded at this run's start (the value saved as last_run), so a row written
  // while the run is in flight isn't read now and again by the next run.
  const auditRows = await fetchAll<{
    changed_at: string; changed_by: string | null
    old_row: Record<string, unknown> | null; new_row: Record<string, unknown> | null
  }>('audit_log', (from, to) => sb
    .from('audit_log')
    .select('changed_at, changed_by, old_row, new_row')
    .gt('changed_at', sinceIso)
    .lte('changed_at', nowIso)
    .order('changed_at').order('id')
    .range(from, to))

  type RawTransition = {
    date: string; slot: 'am' | 'pm'; person: string
    from: string; to: string
    changedBy: string | null; changedAt: string
    bulk?: boolean // part of a bulk clear — see markBulkClears
  }
  const rawTransitions: RawTransition[] = []
  // Work-type (am/pm column) changes, for the OR-time alert and for counting clears.
  const workChanges: RawTransition[] = []

  for (const row of auditRows) {
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

    function pushSlot(target: RawTransition[], slot: 'am' | 'pm', from: string, to: string) {
      if (from === to) return
      // Weekend storage: a Saturday row's pm field represents Sunday.
      const effDate = (dow === 6 && slot === 'pm') ? addDay(date!, 1) : date!
      target.push({ date: effDate, slot, person: person!, from, to, changedBy: row.changed_by, changedAt: row.changed_at })
    }
    pushSlot(rawTransitions, 'am', oldAm, newAm)
    pushSlot(rawTransitions, 'pm', oldPm, newPm)
    const work = (r: Record<string, unknown> | null, f: 'am' | 'pm') => (r?.[f] as string | null | undefined) || ''
    pushSlot(workChanges, 'am', work(row.old_row, 'am'), work(row.new_row, 'am'))
    pushSlot(workChanges, 'pm', work(row.old_row, 'pm'), work(row.new_row, 'pm'))
  }

  // Bulk clears (rebuilding or wiping a stretch of the schedule) would otherwise read as a
  // pile of removals — "Needs coverage!" for each on-call slot, and OR time released for each
  // F/C-surg slot. One account clearing BULK_CLEAR_MIN or more slots to blank (any work type
  // or on-call) within BULK_CLEAR_WINDOW_MS marks those clears as bulk; they are ignored as
  // removals. Only clears to blank count: changing a week to "unavailable" is a real release.
  // (Next week's genuine call gaps are still caught by notify-coverage-gaps' state check.)
  const BULK_CLEAR_MIN = 6
  const BULK_CLEAR_WINDOW_MS = 10 * 60 * 1000
  const isBlank = (v: string) => v === '' || v === 'none'
  {
    const clearsByWho = new Map<string, RawTransition[]>()
    for (const t of [...rawTransitions, ...workChanges]) {
      if (isBlank(t.from) || !isBlank(t.to)) continue
      const who = t.changedBy ?? 'system'
      if (!clearsByWho.has(who)) clearsByWho.set(who, [])
      clearsByWho.get(who)!.push(t)
    }
    for (const clears of clearsByWho.values()) {
      clears.sort((a, b) => a.changedAt.localeCompare(b.changedAt))
      let lo = 0
      for (let hi = 0; hi < clears.length; hi++) {
        while (new Date(clears[hi].changedAt).getTime() - new Date(clears[lo].changedAt).getTime() > BULK_CLEAR_WINDOW_MS) lo++
        if (hi - lo + 1 >= BULK_CLEAR_MIN) for (let k = lo; k <= hi; k++) clears[k].bulk = true
      }
    }
  }

  // Collapse multiple edits to the same (person, date, slot) within this window into a
  // single net transition (earliest "from" -> latest "to"), dropping it entirely if it
  // nets to no change. Otherwise a change-then-revert — or a multi-hop chain, e.g.
  // KP->MC then MC->JH — would replay every intermediate hop (MC would get notified
  // about an assignment they never actually ended up holding) instead of reporting the
  // true before/after for each person.
  function netTransitions(raw: RawTransition[]): RawTransition[] {
    const groups = new Map<string, RawTransition[]>()
    for (const t of raw) {
      const key = `${t.person}|${t.date}|${t.slot}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(t)
    }
    const netted: RawTransition[] = []
    for (const group of groups.values()) {
      const first = group[0]
      const last = group[group.length - 1]
      if (first.from === last.to) continue
      netted.push({
        date: first.date, slot: first.slot, person: first.person,
        from: first.from, to: last.to,
        changedBy: last.changedBy, changedAt: last.changedAt, bulk: last.bulk,
      })
    }
    return netted
  }
  const nettedTransitions = netTransitions(rawTransitions)
  const nettedWork = netTransitions(workChanges)
  let bulkIgnored = 0

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
        from: loss.person, to: gain.person,
        changedBy: loss.changedBy, changedAt: loss.changedAt,
      })
      onCallEvents.push({
        person: gain.person, date: gain.date, role: 'On call',
        from: loss.person, to: gain.person,
        changedBy: gain.changedBy, changedAt: gain.changedAt,
      })
    } else if (loss.bulk) {
      bulkIgnored++
    } else {
      onCallEvents.push({
        person: loss.person, date: loss.date, role: 'On call',
        from: loss.person, ...UNCOVERED,
        changedBy: loss.changedBy, changedAt: loss.changedAt,
      })
    }
  }
  for (const vc of ownChanges) {
    onCallEvents.push({
      person: vc.person, date: vc.date, role: 'On call',
      from: levelLabel(vc.from), to: levelLabel(vc.to),
      changedBy: vc.changedBy, changedAt: vc.changedAt,
    })
  }
  // Unpaired gains are silent — ordinary new scheduling, not a change to something existing.

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Backup/bari changes — resolved value diffed against our own snapshot
  // ═══════════════════════════════════════════════════════════════════════

  // Fetches from one day before the window so a Sunday at the window's start can still
  // look back to its Saturday row (weekend storage: Saturday holds both days' data).
  const assignRangeRows = await fetchAll<{
    date: string; person_id: string; am: string | null; pm: string | null
    oncall_am: string | null; oncall_pm: string | null; exception: boolean | null
  }>('assignments', (from, to) => sb
    .from('assignments')
    .select('date, person_id, am, pm, oncall_am, oncall_pm, exception')
    .gte('date', addDay(yesterday, -1))
    .lte('date', maxDate)
    .order('date').order('person_id')
    .range(from, to))

  const cellData: Record<string, Record<string, Cell>> = {}
  for (const row of assignRangeRows) {
    const person = staffById[row.person_id]?.short_name
    if (!person) continue
    if (!cellData[row.date]) cellData[row.date] = {}
    cellData[row.date][person] = {
      am: row.am || '', pm: row.pm || '',
      oncall_am: row.oncall_am || 'none', oncall_pm: row.oncall_pm || 'none',
      exception: !!row.exception,
    }
  }
  function getCell(dateIso: string, person: string): Cell {
    return cellData[dateIso]?.[person] ?? { am: '', pm: '', oncall_am: 'none', oncall_pm: 'none', exception: false }
  }

  const covRows = await fetchAll<{ date: string; day_call_id: string | null; bari_id: string | null; updated_by: string | null; updated_at: string | null }>(
    'daily_coverage', (from, to) => sb
      .from('daily_coverage')
      .select('date, day_call_id, bari_id, updated_by, updated_at')
      .gte('date', yesterday)
      .lte('date', maxDate)
      .order('date')
      .range(from, to))
  const covByDate: Record<string, { day_call_id: string | null; bari_id: string | null; updated_by: string | null; updated_at: string | null }> =
    Object.fromEntries(covRows.map(r => [r.date, r]))

  // An empty snapshot read would make every date look like a first-time entry (silent) and
  // then overwrite the real snapshot, so it must be a hard failure, never a silent empty.
  const snapRows = await fetchAll<{ date: string; backup_id: string | null; bari_id: string | null }>(
    'assignment_notify_snapshot', (from, to) => sb
      .from('assignment_notify_snapshot')
      .select('date, backup_id, bari_id')
      .gte('date', yesterday)
      .lte('date', maxDate)
      .order('date')
      .range(from, to))
  const snapByDate: Record<string, { backup_id: string | null; bari_id: string | null }> =
    Object.fromEntries(snapRows.map(r => [r.date, r]))

  const coverageEvents: NotifyEvent[] = []
  const newSnapshotRows: Array<{ date: string; backup_id: string | null; bari_id: string | null; updated_at: string }> = []

  // incomingLabel/incomingContext apply only to the "now assigned" (incoming) side — we
  // can only know the current, live exception status, not retroactively whether the
  // outgoing person's assignment was exception-driven, so the outgoing side always uses
  // the plain role label.
  function diffRole(
    role: 'Backup' | 'Bari', date: string, prevId: string | null, newId: string | null,
    changedBy: string | null, changedAt: string | null,
    incomingLabel?: NotifyEvent['role'], incomingContext?: string,
  ) {
    if (prevId === newId) return
    // Resolve against active staff only — a snapshot can reference someone since
    // deactivated. Notify whichever side still resolves; skip the side that doesn't
    // rather than pushing an unresolvable person (which would crash the grouping below).
    const prevName = prevId ? staffById[prevId]?.short_name ?? null : null
    const newName = newId ? staffById[newId]?.short_name ?? null : null
    const newRole = incomingLabel ?? role
    if (!prevId && newId) return // blank -> value: silent, initial entry
    if (prevId && !newId) {
      if (!prevName) return
      coverageEvents.push({
        person: prevName, date, role,
        from: prevName, ...UNCOVERED,
        changedBy, changedAt,
      })
    } else if (prevId && newId && prevId !== newId) {
      const fromLabel = prevName ?? 'Someone else'
      const toLabel = newName ?? 'Someone else'
      if (prevName) coverageEvents.push({
        person: prevName, date, role, from: fromLabel, to: toLabel,
        changedBy, changedAt,
      })
      if (newName) coverageEvents.push({
        person: newName, date, role: newRole, from: fromLabel, to: toLabel,
        note: incomingContext,
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

    // exception means day call for that day even though someone else (or no one) has
    // on-call — a deliberate manual carve-out, distinct from the normal HOSP-derived
    // day call. Only checkable for the *incoming* person — see diffRole's comment.
    const newBackupIsException = resolvedBackupShort ? getCell(dataIso, resolvedBackupShort).exception : false
    let incomingLabel: NotifyEvent['role'] | undefined
    let incomingContext: string | undefined
    if (newBackupIsException) {
      incomingLabel = 'Day call (exception)'
      if (callPerson) {
        const onCallTerm = (dow === 0 || dow === 6) ? 'has on-call' : 'has on-call/night call'
        incomingContext = `${callPerson} ${onCallTerm}`
      }
    }

    const snap = snapByDate[d]
    diffRole('Backup', d, snap?.backup_id ?? null, resolvedBackupId, cov?.updated_by ?? null, cov?.updated_at ?? null, incomingLabel, incomingContext)
    diffRole('Bari', d, snap?.bari_id ?? null, cov?.bari_id ?? null, cov?.updated_by ?? null, cov?.updated_at ?? null)

    newSnapshotRows.push({ date: d, backup_id: resolvedBackupId, bari_id: cov?.bari_id ?? null, updated_at: nowIso })
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 2b. OR time opened up — F-surg/C-surg released and not taken by anyone else
  // ═══════════════════════════════════════════════════════════════════════

  // Counted per (date, slot, type) so a hospital adding a second room (two people on the
  // same F-surg/C-surg slot) still works: time is open only when more people released the
  // slot than picked it up. A hand-off to someone else nets to zero and stays silent.
  const OR_TYPES = ['F-surg', 'C-surg']
  type OrSlot = {
    date: string; slot: 'am' | 'pm'; type: string; claimed: number
    released: Array<{ person: string; changedBy: string | null; changedAt: string }>
  }
  const orSlots = new Map<string, OrSlot>()
  function orSlot(date: string, slot: 'am' | 'pm', type: string): OrSlot {
    const key = `${date}|${slot}|${type}`
    if (!orSlots.has(key)) orSlots.set(key, { date, slot, type, claimed: 0, released: [] })
    return orSlots.get(key)!
  }
  for (const t of nettedWork) {
    if (OR_TYPES.includes(t.from)) {
      if (t.bulk && isBlank(t.to)) { bulkIgnored++; continue }
      orSlot(t.date, t.slot, t.from).released.push({ person: t.person, changedBy: t.changedBy, changedAt: t.changedAt })
    }
    if (OR_TYPES.includes(t.to)) orSlot(t.date, t.slot, t.to).claimed++
  }
  // A CLOSED day clears everyone's assignments, which isn't OR time anyone can claim.
  function isDayClosedOn(dateIso: string): boolean {
    if (!staffRows?.length) return false
    const dow = new Date(dateIso + 'T00:00:00Z').getUTCDay()
    const c = getCell(dow === 0 ? addDay(dateIso, -1) : dateIso, staffRows[0].short_name)
    return dow === 0 ? c.pm === 'CLOSED' : c.am === 'CLOSED'
  }
  const orOpenings = [...orSlots.values()]
    .filter(o => o.released.length > o.claimed && o.date >= today && !isDayClosedOn(o.date))
    .sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot))
  if (bulkIgnored) console.warn(`notify-assignment-changes: ignored ${bulkIgnored} removal(s) that were part of a bulk clear`)

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Compose + send, one digest per affected person
  // ═══════════════════════════════════════════════════════════════════════

  // A weekday's on-call is two independent slots (am/pm) usually moved together by the
  // whole-day drag, so the same swap can produce two events that read identically to the
  // recipient (e.g. am and pm both "Now on call (was MC)") — collapse those into one line.
  //
  // Previously-undeliverable events (assignment_notify_pending) are merged in first so they
  // win the dedupe below — a fresh duplicate of an already-queued event isn't queued twice.
  const pendingSet = new Set<NotifyEvent>()
  const pendingIdsByPerson = new Map<string, number[]>()
  if (!isTest) {
    const pendingRows = await fetchAll<{ id: number; person: string; event_date: string; event: NotifyEvent }>(
      'assignment_notify_pending', (from, to) => sb
        .from('assignment_notify_pending')
        .select('id, person, event_date, event')
        .order('id')
        .range(from, to))
    const staleIds: number[] = []
    for (const r of pendingRows) {
      // Past events are no longer worth sending; so are ones for since-deactivated staff.
      if (r.event_date < yesterday || !staffByShortName[r.person]) { staleIds.push(r.id); continue }
      pendingSet.add(r.event)
      if (!pendingIdsByPerson.has(r.person)) pendingIdsByPerson.set(r.person, [])
      pendingIdsByPerson.get(r.person)!.push(r.id)
    }
    if (staleIds.length) {
      const { error } = await sb.from('assignment_notify_pending').delete().in('id', staleIds)
      if (error) console.error(`notify-assignment-changes: could not clear stale pending rows: ${error.message}`)
    }
  }

  // If an undelivered event can't be queued it would be lost for good once last_run
  // advances, so a failed queue write holds the run's state back (see the persist step).
  let queueWriteFailed = false
  async function queueUndelivered(person: string, events: NotifyEvent[]) {
    const fresh = events.filter(ev => !pendingSet.has(ev))
    if (isTest || !fresh.length) return
    const { error } = await sb.from('assignment_notify_pending').insert(fresh.map(ev => ({ person, event_date: ev.date, event: ev })))
    if (error) {
      queueWriteFailed = true
      console.error(`notify-assignment-changes: could not queue ${fresh.length} undelivered change(s) for ${person}: ${error.message}`)
    }
  }

  const seenEventKeys = new Set<string>()
  const allEvents = [...pendingSet, ...onCallEvents, ...coverageEvents].filter(ev => {
    const key = `${ev.person}|${ev.date}|${ev.role}|${ev.from}|${ev.to}|${ev.changedBy ?? ''}`
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
      console.warn(`notify-assignment-changes: no email on file for ${person}; queueing ${events.length} change(s)`)
      await queueUndelivered(person, events)
      results.push({ person, email: null, sent: false })
      continue
    }
    events.sort((a, b) => a.date.localeCompare(b.date))

    const who = (v: string) => v === person ? 'You' : v
    const whoHtml = (v: string) => v === person ? `<strong>You</strong>` : escapeHtml(v)

    const rowsHtml = events.map(ev => `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1">${escapeHtml(fmtDay(ev.date))}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1">${escapeHtml(ev.role)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1">${whoHtml(ev.from)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1">${whoHtml(ev.to)}${ev.note ? `<br><span style="color:#607D8B;font-size:0.82rem">${escapeHtml(ev.note)}</span>` : ''}</td>
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
      <th style="padding:6px 10px;text-align:left">Was</th>
      <th style="padding:6px 10px;text-align:left">Now</th>
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
      ...events.map(ev => `${fmtDay(ev.date)} — ${ev.role}: ${who(ev.from)} → ${who(ev.to)}${ev.note ? ` (${ev.note})` : ''} (by ${labelForChanger(ev.changedBy)} at ${fmtWhen(ev.changedAt)})`),
    ].join('\n')

    // A thrown fetch is treated like a rejection — otherwise the run would abort before
    // persisting state and re-scan (and re-email) everyone already notified.
    let res: Response | null = null
    try {
      res = await fetch('https://api.resend.com/emails', {
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
      if (!res.ok) {
        console.error(`notify-assignment-changes: Resend rejected send for ${person} (${res.status}): ${await res.text()}`)
      }
    } catch (e) {
      console.error(`notify-assignment-changes: send failed for ${person}: ${e}`)
    }
    const sent = !!res?.ok
    if (sent) {
      const ids = pendingIdsByPerson.get(person)
      if (!isTest && ids?.length) {
        // Failing here means the same events are re-sent tomorrow; log it rather than abort,
        // since the email did go out.
        const { error } = await sb.from('assignment_notify_pending').delete().in('id', ids)
        if (error) console.error(`notify-assignment-changes: sent but could not clear pending rows for ${person}: ${error.message}`)
      }
    } else {
      await queueUndelivered(person, events)
    }
    results.push({ person, email: toEmail, sent })
  }

  // ── OR time alert: every surgeon with an email (not the people who released it) ──
  // No retry queue — a missed alert about open OR time is stale by the next run. Surgeons
  // with no email are only logged.
  const orResults: Array<{ person: string; sent: boolean }> = []
  if (orOpenings.length) {
    const slotLabel = (o: OrSlot) => {
      const dow = new Date(o.date + 'T00:00:00Z').getUTCDay()
      return (dow === 0 || dow === 6) ? '' : o.slot.toUpperCase()
    }
    async function sendOrAlert(to: string, openings: OrSlot[], banner: string) {
      const rowsHtml = openings.map(o => `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1">${escapeHtml(fmtDay(o.date))} ${escapeHtml(slotLabel(o))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1"><strong>${escapeHtml(o.type)}</strong></td>
        <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1">${escapeHtml(o.released.map(r => r.person).join(', '))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #ECEFF1;color:#607D8B;font-size:0.82rem">${escapeHtml(labelForChanger(o.released[o.released.length - 1].changedBy))}<br>${escapeHtml(fmtWhen(o.released[o.released.length - 1].changedAt))}</td>
      </tr>`).join('\n')
      const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#37474F;max-width:650px;margin:0 auto;padding:24px">
  ${banner}
  <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:4px">OR time now open</h2>
  <p style="font-size:0.9rem;color:#607D8B;margin-top:0;margin-bottom:16px">
    These F-surg/C-surg assignments were released and nobody has taken them. Talk to a scheduler if you'd like one.
  </p>
  <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
    <thead><tr style="background:#F5F7FA">
      <th style="padding:6px 10px;text-align:left">Date</th>
      <th style="padding:6px 10px;text-align:left">OR time</th>
      <th style="padding:6px 10px;text-align:left">Released by</th>
      <th style="padding:6px 10px;text-align:left">Changed by</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body></html>`
      const text = [
        'OR time now open — released and not taken by anyone:',
        '',
        ...openings.map(o => `${fmtDay(o.date)} ${slotLabel(o)} — ${o.type} (released by ${o.released.map(r => r.person).join(', ')})`),
      ].join('\n')
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Call Calendar <noreply@ssrounds.com>',
            to,
            subject: `${isTest ? '[TEST] ' : ''}OR time now open${openings.length > 1 ? ` (${openings.length} slots)` : ''}`,
            html, text,
          }),
        })
        if (!res.ok) console.error(`notify-assignment-changes: OR alert rejected for ${to} (${res.status}): ${await res.text()}`)
        return res.ok
      } catch (e) {
        console.error(`notify-assignment-changes: OR alert failed for ${to}: ${e}`)
        return false
      }
    }

    if (isTest) {
      const banner = `<p style="background:#FFF3E0;color:#E65100;padding:8px 12px;border-radius:4px;font-size:0.85rem">TEST RUN — a real run sends each surgeon only the slots they didn't release themselves.</p>`
      orResults.push({ person: '(test)', sent: await sendOrAlert(testEmail!, orOpenings, banner) })
    } else {
      for (const r of (staffRows ?? []).filter(r => r.is_surgeon !== false)) {
        const mine = orOpenings.filter(o => !o.released.some(x => x.person === r.short_name))
        if (!mine.length) continue
        const toEmail = emailFor(r.short_name)
        if (!toEmail) {
          console.warn(`notify-assignment-changes: no email on file for surgeon ${r.short_name}; OR-time alert not sent`)
          orResults.push({ person: r.short_name, sent: false })
          continue
        }
        orResults.push({ person: r.short_name, sent: await sendOrAlert(toEmail, mine, '') })
      }
    }
  }

  // ── Remind the office contact (or all admins) while anything is undeliverable ──
  // Throttled per row by last_alerted_at; the queue itself empties on delivery or once the
  // event dates pass, which also ends the reminders.
  if (!isTest) {
    const rows = await fetchAll<{ id: number; person: string; event_date: string; last_alerted_at: string | null }>(
      'assignment_notify_pending (outstanding)', (from, to) => sb
        .from('assignment_notify_pending')
        .select('id, person, event_date, last_alerted_at')
        .order('id')
        .range(from, to))
    const cutoff = now.getTime() - 20 * 3_600_000
    if (rows.some(r => !r.last_alerted_at || new Date(r.last_alerted_at).getTime() < cutoff)) {
      const byWho = new Map<string, { count: number; earliest: string }>()
      for (const r of rows) {
        const cur = byWho.get(r.person)
        if (!cur) byWho.set(r.person, { count: 1, earliest: r.event_date })
        else { cur.count++; if (r.event_date < cur.earliest) cur.earliest = r.event_date }
      }
      const noEmail = [...byWho].filter(([p]) => !emailFor(p))
      const failing = [...byWho].filter(([p]) => !!emailFor(p))
      const li = ([p, v]: [string, { count: number; earliest: string }]) =>
        `<li><strong>${escapeHtml(p)}</strong> — ${v.count} change${v.count > 1 ? 's' : ''} waiting (earliest ${escapeHtml(fmtDay(v.earliest))})</li>`

      const officeUserId = co?.office_contact_user_id as string | null | undefined
      let alertTo: string[] = officeUserId && emailByUserId[officeUserId] ? [emailByUserId[officeUserId]] : []
      if (!alertTo.length) {
        const adminProfiles = check('admin profiles', await sb.from('profiles').select('email').eq('role', 'admin'))
        alertTo = (adminProfiles ?? []).map(p => p.email).filter(Boolean)
      }

      if (alertTo.length) {
        const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#37474F;max-width:650px;margin:0 auto;padding:24px">
  <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:4px">Call schedule notifications not delivered</h2>
  ${noEmail.length ? `<p style="font-size:0.9rem">These people have schedule changes waiting but <strong>no email on file</strong>. Link an account or add an email for them in Settings → Staff; the changes will be sent on the next daily run.</p><ul>${noEmail.map(li).join('')}</ul>` : ''}
  ${failing.length ? `<p style="font-size:0.9rem">Sending to these people is <strong>failing</strong> (check the notify-assignment-changes logs). It will keep retrying daily.</p><ul>${failing.map(li).join('')}</ul>` : ''}
  <p style="font-size:0.78rem;color:#90A4AE;margin-top:20px">You'll get this reminder daily until the changes are delivered or their dates pass.</p>
</body></html>`
        let alertRes: Response | null = null
        try {
          alertRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'Call Calendar <noreply@ssrounds.com>',
              to: alertTo,
              subject: 'Action needed: call schedule notifications not delivered',
              html,
            }),
          })
          if (!alertRes.ok) console.error(`notify-assignment-changes: office alert rejected (${alertRes.status}): ${await alertRes.text()}`)
        } catch (e) {
          console.error(`notify-assignment-changes: office alert failed: ${e}`)
        }
        if (alertRes?.ok) {
          await sb.from('assignment_notify_pending').update({ last_alerted_at: nowIso }).in('id', rows.map(r => r.id))
        }
      } else {
        console.warn('notify-assignment-changes: undelivered changes outstanding but no office contact or admin email to alert')
      }
    }
  }

  // ── Persist state (skipped entirely for test runs) ────────────────────
  // Neither the snapshot nor last_run may advance unless the whole run's changes are either
  // delivered or safely queued; otherwise the next run would diff against a baseline that
  // already skips them.
  if (!isTest) {
    if (queueWriteFailed) throw new Error('could not queue undelivered changes')
    if (newSnapshotRows.length) {
      const { error } = await sb.from('assignment_notify_snapshot').upsert(newSnapshotRows)
      if (error) throw new Error(`saving snapshot: ${error.message}`)
    }
    const { error } = await sb.from('company_info').update({ assignment_notify_last_run: nowIso }).eq('id', 1)
    if (error) throw new Error(`saving last run: ${error.message}`)
  }

  return new Response(JSON.stringify({
    window: { from: yesterday, to: maxDate },
    onCallEvents: onCallEvents.length,
    coverageEvents: coverageEvents.length,
    orOpenings: orOpenings.length,
    notified: results,
    orNotified: orResults,
  }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
