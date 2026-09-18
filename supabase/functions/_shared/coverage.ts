// Resolves the day-call/backup person to display for a given day.
// `stored` is daily_coverage.day_call_id for this date — the app computes and persists
// this (override or algorithm result) on every assignment save, so it's already the
// resolved value whenever it's present. The only gap: on a CLOSED day with nothing
// stored, fall back to whoever's on call (holiday arrangement) — mirrors index.html's
// updateDaySummary/dayCoverageClass conventions.
export function resolveDayCall(
  stored: string | null | undefined,
  dayClosed: boolean,
  onCallPerson: string,
): string {
  if (stored !== null && stored !== undefined) return stored
  if (dayClosed) return onCallPerson
  return ''
}
