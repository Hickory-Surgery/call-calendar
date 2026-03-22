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
  const person = url.searchParams.get('person')?.trim()
  const token = url.searchParams.get('token')?.trim()

  if (!person || !token) {
    return new Response('Missing person or token', { status: 400 })
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

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

  const now = icalNow()
  const events: string[] = []

  for (const row of (rows as AssignmentRow[]) ?? []) {
    const dow = new Date(row.date + 'T00:00:00Z').getUTCDay() // 0=Sun, 6=Sat

    if (dow === 6) {
      // Saturday date: am = Saturday assignment, pm = Sunday assignment
      const satSummary = makeSummary(row.am, row.am, row.oncall_am, row.oncall_am, row.exception)
      if (row.am || row.oncall_am !== 'none') {
        events.push(buildEvent(`${row.date}-${person}-sat@hickory-surgery`, row.date, satSummary, now))
      }
      if (row.pm || row.oncall_pm !== 'none') {
        const sunDate = addDay(row.date, 1)
        const sunSummary = makeSummary(row.pm, row.pm, row.oncall_pm, row.oncall_pm, false)
        events.push(buildEvent(`${sunDate}-${person}-sun@hickory-surgery`, sunDate, sunSummary, now))
      }
    } else {
      // Weekday
      const summary = makeSummary(row.am, row.pm, row.oncall_am, row.oncall_pm, row.exception)
      if (row.am || row.pm || row.oncall_am !== 'none' || row.oncall_pm !== 'none') {
        events.push(buildEvent(`${row.date}-${person}@hickory-surgery`, row.date, summary, now))
      }
    }
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
