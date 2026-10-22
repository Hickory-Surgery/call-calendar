# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A surgical call calendar for a small medical practice. Deployed as a static site on GitHub Pages at `https://montycox.github.io/call-calendar/`. There is no build step — `index.html` is the entire application.

## Deployment

```bash
git push   # deploys automatically via GitHub Pages
```

## Architecture

**Single-file app** (`index.html`) — all HTML, CSS, and JavaScript in one file. No framework, no bundler, no package.json.

**Backend: Supabase** (PostgreSQL + Auth + Realtime)
- Auth: Email/password via Supabase Auth. Role stored in `profiles` table (`viewer`, `scheduler`, `admin`).
- `staff` table: uuid PK, short_name, display_name, is_bariatric, sort_order, active
- `assignments` table: uuid PK, date, person_id FK, am, pm, oncall_am, oncall_pm (all TEXT), exception (bool). Unique constraint on (date, person_id). REPLICA IDENTITY FULL.
- `daily_coverage` table: date PK, day_call_id FK, bari_id FK, bari_class_id FK, manual flags. Holds computed-or-manual per-day coverage assignments.
- Real-time: Supabase channel subscribed to `assignments` + `daily_coverage` via `supabase_realtime` publication

**Data flow on load:** `applySession()` → `fetchStaff()` → `fetchAssignments()` + `fetchDailyCoverage()` (parallel) → `setupRealtimeSubscriptions()` → `render()`

## Key data model conventions

- **`cellKey(y, m, d, person)`** → `"${y}-${m+1}-${d}-${person}"` (no zero-padding, m is 1-based in key). This is the in-memory map key for the `data` object.
- **Weekend storage**: Saturday and Sunday share one `data` entry stored under the Saturday date. `am` = Saturday assignment, `pm` = Sunday assignment.
- **On-call values**: `oncall_am` / `oncall_pm` are strings: `'none'`, `'single'`, `'double'`. Never booleans.
- **`isoFromParts(y, m, d)`**: m is 0-indexed (JS Date convention) → produces `YYYY-MM-DD` for Supabase.
- **`isoToDateParts(iso)`**: inverse — returns `{ y, m, d }` where m is 0-indexed.
- **`weekKey(sat)`**: returns the Monday of the week as `"${y}-${m+1}-${d}"` (1-based month, no padding) — used as the `bariCall` map key.

## Staff lookup maps

After `fetchStaff()`, three parallel structures are maintained:
- `staff` — ordered array of short_names (e.g. `["KP","MC","GA","BH","JH","JL"]`)
- `staffByShortName` — `{ shortName → supabase row }` (use for writes: need `.id`)
- `staffById` — `{ uuid → supabase row }` (use when reading from Supabase responses)

## Writes are optimistic

`setCell()` and `clearCell()` update `data` immediately, fire async Supabase upsert/delete, and rollback + `showToast()` on error. Real-time events from other clients also update `data` and call `render()`.

## Role-based access

`currentRole` is `'viewer'` | `'scheduler'` | `'admin'`. Guards: `canEdit()` and `isAdmin()`. New users require manual approval — an admin must insert a row into the `profiles` table (or use the Users panel in settings, which calls the `create_profile` RPC).

## Auth

Email/password via Supabase Auth. `applySession()` is guarded by `sessionApplied` to prevent double-load when both `getSession()` and `onAuthStateChange` fire simultaneously. The flag resets on sign-out. New users who sign up without an approved `profiles` row are signed out automatically and shown "pending admin approval"; the `notify-new-user` edge function fires once to alert admins.

## Scroll snap

After scroll ends (160 ms debounce), the section straddling the sticky header is inspected:
- `visibleBelow < 6 rows` → snap forward to next month
- `scrolledPast < 8 rows` → snap back to top of current month

Thresholds are `THRESHOLD_FWD` (6 × 22 px) and `THRESHOLD_BACK` (8 × 22 px) in `setupScrollSnap()`.

## Development workflow

### Supabase migrations

Migration files live in `supabase/migrations/`. Always use **14-digit timestamps** (`YYYYMMDDHHmmss`) — e.g. `20260510000000_my_change.sql`. This avoids version collisions when multiple migrations share the same date.

```bash
supabase migration list          # compare local vs remote
supabase db push                 # apply pending migrations to production
```

If a migration was applied manually (via SQL editor) and not tracked by the CLI, mark it as applied without re-running it:
```bash
supabase migration repair --status applied 20260510000000
```

**Data API grants (tables created on/after 2026-10-30):** per a Supabase notice (email, not independently verified), `public` tables created from that date are no longer auto-granted Data API access. Include explicit `GRANT`s in the same migration as any new table, e.g. `select` to `anon` (only if it should be public) and `select, insert, update, delete` to `authenticated` and `service_role`; RLS still controls row access. Existing tables keep their grants. Migrations that predate this (e.g. `audit_log`, `staff_link_audit`) have no grants, and several core tables (`staff`, `assignments`, `daily_coverage`, `profiles`) aren't created by any migration, so a fresh-project/`db reset` rebuild from this repo won't work as-is.

### Database connection

The direct DB host (`db.pkjlnjsswoadftkseffo.supabase.co`) is **IPv6-only**. For any tooling that needs a DB connection from an IPv4 network (e.g. CI, local pg_dump), use the **session pooler**:
```
postgresql://postgres.pkjlnjsswoadftkseffo:[PASSWORD]@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require
```

### Backups

Automated weekly backup runs every Sunday at 4am UTC via GitHub Actions (`.github/workflows/db-backup.yml`). Dumps `schema.sql` + `data.sql` and uploads as workflow artifacts (retained 90 days). Requires `SUPABASE_DB_PASSWORD` secret in the GitHub repo. Uses `pg_dump` v17 from the PGDG apt repo via the session pooler.

## Historical data import (`convert_sheets.py`)

Reads the HSC Call Google Sheets spreadsheet via the Sheets API (no external Python libraries — uses `urllib` only) and outputs `call-calendar-import.json` for in-app import.

```bash
python3 convert_sheets.py YOUR_API_KEY [--debug [month_name]]
# Examples:
python3 convert_sheets.py AIza... --debug may
python3 convert_sheets.py AIza...
```

Key conventions in the converter:
- **Fixed block layout**: staff rows always at spreadsheet rows 4–9, 12–17, 20–25, … (every 8 rows). Row order within a block = staff order (KP, MC, GA, BH, JH, JL).
- **Column layout** (0-based): Mon AM/PM = 1/2, Tue = 4/5, Wed = 7/8, Thu = 10/11, Fri = 13/14, Sat = col 16 → `am`, Sun = col 17 → `pm`.
- **On-call colors**: orange `{red:1, green:0.6}` → `'double'`; yellow `{red:1, green:1}` → `'single'`; green cells = import data but no on-call flag.
- The Sheets API omits color channels that are 0, so missing channels default to `0.0` (not `1.0`).
