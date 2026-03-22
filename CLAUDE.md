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
- Auth: Google OAuth via PKCE flow. Role stored in `profiles` table (`viewer`, `scheduler`, `admin`).
- `staff` table: uuid PK, short_name, display_name, is_bariatric, sort_order, active
- `assignments` table: uuid PK, date, person_id FK, am, pm, oncall_am, oncall_pm (all TEXT), exception (bool). Unique constraint on (date, person_id). REPLICA IDENTITY FULL.
- `bari_call` table: week_start date PK, person_id FK
- Real-time: Supabase channel subscribed to `assignments` + `bari_call` via `supabase_realtime` publication

**Data flow on load:** `applySession()` → `fetchStaff()` → `fetchAssignments()` + `fetchBariCall()` (parallel) → `setupRealtimeSubscriptions()` → `render()`

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
