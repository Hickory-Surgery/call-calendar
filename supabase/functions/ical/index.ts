import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ASSIGN_LABEL: Record<string, string> = {
  'ov': 'OV', 'hosp': 'HOSP', 'C-surg': 'C-Surg', 'F-surg': 'F-Surg',
  'ba-C': 'Ba-C', 'ba-F': 'Ba-F', 'admin': 'Admin',
  'unavailable': 'Unavailable', 'CLOSED': 'CLOSED', '': '',
}

function assignLabel(val: string): string {
  return ASSIGN_LABEL[val] ?? val
}

function makeSummary(am: string, pm: string, oncall_am: string, oncall_pm: string, exception: boolean): string {
  // Assignment string
  let assign: string
  if (am === pm) {
    assign = assignLabel(am)
  } else {
    const parts = []
    if (am) parts.push(`AM: ${assignLabel(am)}`)
    if (pm) parts.push(`PM: ${assignLabel(pm)}`)
    assign = parts.join(' / ')
  }

  // Oncall string — take the "stronger" of am/pm
  const oncall = (oncall_am === 'double' || oncall_pm === 'double') ? 'double'
    : (oncall_am === 'single' || oncall_pm === 'single') ? 'single'
    : 'none'
  const oncallStr = oncall === 'double' ? 'Double Call' : oncall === 'single' ? 'On Call' : ''

  const exStr = exception ? ' (exception)' : ''
  return [assign, oncallStr + exStr].filter(Boolean).join(' · ') || 'Assignment'
}

// RFC 5545 line folding: max 75 octets per line, continuation lines start with a space
function fold(line: string): string {
  if (line.length <= 75) return line
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    const limit = i === 0 ? 75 : 74
    out.push((i > 0 ? ' ' : '') + line.slice(i, i + limit))
    i += limit
  }
  return out.join('\r\n')
}

function icalDate(dateStr: string): string {
  return dateStr.replace(/-/g, '') // "2026-03-15" → "20260315"
}

function icalNow(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z'
}

// Add N days to a YYYY-MM-DD string
function addDay(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

interface AssignmentRow {
  date: string
  am: string
  pm: string
  oncall_am: string
  oncall_pm: string
  exception: boolean
}

function buildEvent(uid: string, dateStr: string, summary: string, now: string): string {
  const lines = [
    'BEGIN:VEVENT',
    fold(`UID:${uid}`),
    `DTSTAMP:${now}`,
    `DTSTART;VALUE=DATE:${icalDate(dateStr)}`,
    `DTEND;VALUE=DATE:${icalDate(addDay(dateStr, 1))}`,
    fold(`SUMMARY:${summary}`),
    'END:VEVENT',
  ]
  return lines.join('\r\n')
}

function buildICal(calName: string, person: string, events: string[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hickory Surgery//Call Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${calName} – Call Schedule`),
    'X-WR-TIMEZONE:America/New_York',
    ...events,
    'END:VCALENDAR',
  ]
  return lines.join('\r\n')
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const mode   = url.searchParams.get('mode')?.trim()   // 'oncall' for practice feed
  const person = url.searchParams.get('person')?.trim()
  const token  = url.searchParams.get('token')?.trim()

  if (!token || (!person && mode !== 'oncall')) {
    return new Response('Missing person or token', { status: 400 })
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // ── Practice on-call + bari-call feed ────────────────────────────────────
  if (mode === 'oncall') {
    const { data: co } = await sb.from('company_info').select('call_feed_token, name').eq('id', 1).maybeSingle()
    if (!co?.call_feed_token || token !== co.call_feed_token) {
      return new Response('Invalid token', { status: 403 })
    }

    const { data: staffRows } = await sb.from('staff').select('id, short_name').eq('active', true)
    // deno-lint-ignore no-explicit-any
    const nameById: Record<string, string> = Object.fromEntries((staffRows ?? []).map((r: any) => [r.id, r.short_name]))

    // dateIso → [shortName, ...] for people who are on-call that day
    const oncallMap: Record<string, string[]> = {}
    const { data: assignRows } = await sb
      .from('assignments')
      .select('date, person_id, oncall_am, oncall_pm')
      .or('oncall_am.neq.none,oncall_pm.neq.none')
      .order('date')
    // deno-lint-ignore no-explicit-any
    for (const row of (assignRows ?? []) as any[]) {
      const name = nameById[row.person_id]
      if (!name) continue
      const dow = new Date(row.date + 'T00:00:00Z').getUTCDay()
      if (dow === 6) {
        // Saturday row: oncall_am = Sat, oncall_pm = Sun
        if (row.oncall_am !== 'none') {
          oncallMap[row.date] = [...(oncallMap[row.date] ?? []), name]
        }
        if (row.oncall_pm !== 'none') {
          const sunDate = addDay(row.date, 1)
          oncallMap[sunDate] = [...(oncallMap[sunDate] ?? []), name]
        }
      } else {
        oncallMap[row.date] = [...(oncallMap[row.date] ?? []), name]
      }
    }

    // dateIso → shortName for the bari-call person (weekly designee)
    const bariMap: Record<string, string> = {}
    const { data: bariRows } = await sb.from('bari_call').select('week_start, person_id')
    // deno-lint-ignore no-explicit-any
    for (const row of (bariRows ?? []) as any[]) {
      const name = nameById[row.person_id]
      if (!name) continue
      for (let i = 0; i < 7; i++) bariMap[addDay(row.week_start, i)] = name
    }

    // Override with coverage_overrides.bari_id for specific dates
    const { data: bariOvRows } = await sb
      .from('coverage_overrides').select('date, bari_id').not('bari_id', 'is', null)
    // deno-lint-ignore no-explicit-any
    for (const row of (bariOvRows ?? []) as any[]) {
      const name = nameById[row.bari_id]
      if (name) bariMap[row.date] = name
    }

    const allDates = [...new Set([...Object.keys(oncallMap), ...Object.keys(bariMap)])].sort()
    const now = icalNow()
    const events: string[] = []
    for (const dateIso of allDates) {
      const oncallNames = oncallMap[dateIso] ?? []
      const bariName    = bariMap[dateIso]
      const parts: string[] = []
      if (oncallNames.length) parts.push(`On Call: ${oncallNames.join(' · ')}`)
      if (bariName)           parts.push(`Bari: ${bariName}`)
      events.push(buildEvent(`${dateIso}-oncall@hickory-surgery`, dateIso, parts.join(' | '), now))
    }

    const calName = (co.name ?? 'Practice') + ' On Call & Bari'
    return new Response(buildICal(calName, 'oncall', events), {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="oncall.ics"',
      },
    })
  }

  // Validate token
  const { data: staffRow, error: staffErr } = await sb
    .from('staff')
    .select('id, short_name, display_name, feed_token')
    .eq('short_name', person)
    .eq('feed_token', token)
    .single()

  if (staffErr || !staffRow) {
    return new Response('Invalid person or token', { status: 403 })
  }

  // Fetch all assignments for this person
  const { data: rows, error: assignErr } = await sb
    .from('assignments')
    .select('date, am, pm, oncall_am, oncall_pm, exception')
    .eq('person_id', staffRow.id)
    .order('date')

  if (assignErr) {
    return new Response('Error fetching assignments', { status: 500 })
  }

  // Fetch coverage overrides where this person is manually set as backup or bari
  const { data: ovRows } = await sb
    .from('coverage_overrides')
    .select('date, backup_id, bari_id')
    .or(`backup_id.eq.${staffRow.id},bari_id.eq.${staffRow.id}`)

  // Map of dateIso → { backup: bool, bari: bool }
  const overrideMap: Record<string, { backup: boolean; bari: boolean }> = {}
  for (const ov of ovRows ?? []) {
    overrideMap[ov.date] = {
      backup: ov.backup_id === staffRow.id,
      bari:   ov.bari_id   === staffRow.id,
    }
  }

  function overrideSuffix(dateIso: string): string {
    const ov = overrideMap[dateIso]
    if (!ov) return ''
    const parts = []
    if (ov.backup) parts.push('Backup')
    if (ov.bari)   parts.push('Bari Call')
    return parts.length ? ' · ' + parts.join(' · ') : ''
  }

  const now = icalNow()
  const events: string[] = []
  const assignmentDates = new Set<string>()

  for (const row of (rows as AssignmentRow[]) ?? []) {
    const dow = new Date(row.date + 'T00:00:00Z').getUTCDay() // 0=Sun, 6=Sat

    if (dow === 6) {
      // Saturday date: am = Saturday assignment, pm = Sunday assignment
      const sunDate = addDay(row.date, 1)
      assignmentDates.add(row.date)
      assignmentDates.add(sunDate)
      const satSummary = makeSummary(row.am, row.am, row.oncall_am, row.oncall_am, row.exception) + overrideSuffix(row.date)
      if (row.am || row.oncall_am !== 'none' || overrideMap[row.date]) {
        events.push(buildEvent(`${row.date}-${person}-sat@hickory-surgery`, row.date, satSummary, now))
      }
      const sunSummary = makeSummary(row.pm, row.pm, row.oncall_pm, row.oncall_pm, false) + overrideSuffix(sunDate)
      if (row.pm || row.oncall_pm !== 'none' || overrideMap[sunDate]) {
        events.push(buildEvent(`${sunDate}-${person}-sun@hickory-surgery`, sunDate, sunSummary, now))
      }
    } else {
      // Weekday
      assignmentDates.add(row.date)
      const summary = makeSummary(row.am, row.pm, row.oncall_am, row.oncall_pm, row.exception) + overrideSuffix(row.date)
      if (row.am || row.pm || row.oncall_am !== 'none' || row.oncall_pm !== 'none' || overrideMap[row.date]) {
        events.push(buildEvent(`${row.date}-${person}@hickory-surgery`, row.date, summary, now))
      }
    }
  }

  // Standalone events for override dates with no assignment (edge case)
  for (const dateIso of Object.keys(overrideMap)) {
    if (assignmentDates.has(dateIso)) continue
    const suffix = overrideSuffix(dateIso).slice(3) // strip leading ' · '
    events.push(buildEvent(`${dateIso}-${person}-ov@hickory-surgery`, dateIso, suffix, now))
  }

  const displayName = staffRow.display_name || staffRow.short_name
  const ical = buildICal(displayName, person, events)

  return new Response(ical, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${person}-call.ics"`,
    },
  })
})
