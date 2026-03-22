#!/usr/bin/env python3
"""
Convert HSC Call Google Sheets to JSON for import into call-calendar app.

Usage:
    python3 convert_sheets.py YOUR_API_KEY [--debug]

Output:
    call-calendar-import.json  (ready to import via Settings > Import data from JSON)

Setup:
    1. Go to https://console.cloud.google.com/
    2. Create or select a project, enable "Google Sheets API"
    3. Create an API key (Credentials > Create Credentials > API key)
    4. Run: python3 convert_sheets.py YOUR_API_KEY
"""

import datetime
import json
import sys
import urllib.request
import urllib.error

SPREADSHEET_ID = "1Nd2pobreYy0iOBk2bodttuEAmabRQQ7aNtaMDP7Sd0o"
YEAR = 2026

SHEETS_TO_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4,
    "may": 5, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "oct": 10, "nov": 11,
}

# Row order within each week block → app short_name
STAFF_ORDER = ["KP", "MC", "GA", "BH", "JH", "JL"]

# Fixed column positions (0-based) for each day's AM and PM slots.
# The grid is 18 columns wide (cols 0–17); col 0/3/6/9/12/15 are person/separator
# cols and are empty in the API — person is identified by row order instead.
DAY_COLS = [
    (1,  2),   # Monday   AM, PM
    (4,  5),   # Tuesday  AM, PM
    (7,  8),   # Wednesday AM, PM
    (10, 11),  # Thursday  AM, PM
    (13, 14),  # Friday    AM, PM
]
# Weekend: stored under Saturday's date; am = Saturday, pm = Sunday
SAT_COL = 16
SUN_COL = 17

# Any of these columns having a value marks a row as a staff row
ASSIGNMENT_COLS = [c for pair in DAY_COLS for c in pair] + [SAT_COL, SUN_COL]

ASSIGNMENT_NORM = {
    "surg":        "F-surg",
    "ba-c":        "ba-C",
    "ba-f":        "ba-F",
    "- CLOSED -":  "CLOSED",
    "CLOSED":      "CLOSED",
}


# ── Color detection ───────────────────────────────────────────────────────────

def _channels(bg):
    if not bg:
        return 1.0, 1.0, 1.0
    return bg.get("red", 0.0), bg.get("green", 0.0), bg.get("blue", 0.0)


def is_yellow(bg):
    r, g, b = _channels(bg)
    return r > 0.8 and g > 0.75 and b < 0.25


def is_orange(bg):
    r, g, b = _channels(bg)
    return r > 0.8 and 0.25 <= g < 0.75 and b < 0.25


def is_colored(bg):
    r, g, b = _channels(bg)
    return not (r > 0.95 and g > 0.95 and b > 0.95)


def oncall_flags(bg):
    """Return (oncall_am, oncall_pm) as app string values: 'none'/'single'/'double'.
    Green = no oncall (import data as-is)."""
    if is_orange(bg):
        return 'double', 'double'
    if is_yellow(bg):
        return 'single', 'single'
    return 'none', 'none'


# ── Sheets API ────────────────────────────────────────────────────────────────

def fetch_spreadsheet(api_key):
    url = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}"
        f"?includeGridData=true"
        f"&key={api_key}"
    )
    try:
        with urllib.request.urlopen(url) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"HTTP {e.code}: {e.reason}\n{body[:400]}")
        sys.exit(1)


def get_cell(row_data, col):
    """Return (string_value, background_color) for cell at column index."""
    values = row_data.get("values", [])
    if col >= len(values):
        return "", None
    cell = values[col]

    uev = cell.get("userEnteredValue", {})
    if "stringValue" in uev:
        val = uev["stringValue"]
    elif "numberValue" in uev:
        n = uev["numberValue"]
        val = str(int(n)) if n == int(n) else str(n)
    else:
        val = ""

    fmt = cell.get("userEnteredFormat", {})
    bg = fmt.get("backgroundColor")
    if bg and not is_colored(bg):
        bg = None

    return val.strip(), bg


# ── Week-block detection ──────────────────────────────────────────────────────


# The sheet layout is fixed: first staff row at row 4 (0-based),
# then a new block every 8 rows (1 header + 6 staff + 1 separator).
FIRST_STAFF_ROW = 4
BLOCK_SIZE = 8
STAFF_PER_BLOCK = 6
MAX_BLOCKS = 6  # no month spans more than 6 calendar weeks


def find_week_blocks(rows):
    """
    Return list of [row_idx_0 .. row_idx_5] for each week block.
    Uses the fixed layout (blocks at rows 4-9, 12-17, 20-25, …) rather than
    trying to detect consecutive non-empty rows, which breaks when some staff
    rows in a block are fully empty.
    """
    blocks = []
    for b in range(MAX_BLOCKS):
        start = FIRST_STAFF_ROW + b * BLOCK_SIZE
        if start + STAFF_PER_BLOCK > len(rows):
            break
        blocks.append(list(range(start, start + STAFF_PER_BLOCK)))
    return blocks


def monday_for_block(year, month, block_index):
    """Return the Monday date for week block `block_index` (0-based) in month."""
    first = datetime.date(year, month, 1)
    dow = first.weekday()          # 0 = Mon … 6 = Sun
    first_monday = first - datetime.timedelta(days=dow)
    return first_monday + datetime.timedelta(weeks=block_index)


# ── Per-sheet parser ──────────────────────────────────────────────────────────

def normalize(val):
    return ASSIGNMENT_NORM.get(val, val)


def parse_sheet(sheet_name, sheet_obj, month):
    grid_data = sheet_obj.get("data", [{}])[0]
    rows = grid_data.get("rowData", [])

    blocks = find_week_blocks(rows)
    data = {}

    for block_idx, row_indices in enumerate(blocks):
        monday = monday_for_block(YEAR, month, block_idx)

        for row_offset, ri in enumerate(row_indices):
            if row_offset >= len(STAFF_ORDER):
                break
            person = STAFF_ORDER[row_offset]
            row = rows[ri]

            # ── Weekdays (Mon–Fri) ──────────────────────────────────────────
            for day_offset, (am_col, pm_col) in enumerate(DAY_COLS):
                date = monday + datetime.timedelta(days=day_offset)
                am_val, am_bg = get_cell(row, am_col)
                pm_val, pm_bg = get_cell(row, pm_col)

                am = normalize(am_val)
                pm = normalize(pm_val)
                bg = am_bg or pm_bg
                oncall_am, oncall_pm = oncall_flags(bg)

                has_data = am or pm or oncall_am != 'none' or oncall_pm != 'none'
                if not has_data:
                    continue

                # cellKey: `${y}-${m+1}-${d}-${person}` (no zero-padding, m is 1-based)
                key = f"{date.year}-{date.month}-{date.day}-{person}"
                data[key] = {"am": am, "pm": pm,
                             "oncall_am": oncall_am, "oncall_pm": oncall_pm}

            # ── Weekend (Sat col 16, Sun col 17) ────────────────────────────
            # App model: am = Saturday, pm = Sunday, stored under Saturday's date.
            sat_date = monday + datetime.timedelta(days=5)
            sat_val, sat_bg = get_cell(row, SAT_COL)
            sun_val, sun_bg = get_cell(row, SUN_COL)

            sat_assign = normalize(sat_val)
            sun_assign = normalize(sun_val)
            oncall_am, oncall_pm = oncall_flags(sat_bg or sun_bg)

            if sat_assign or sun_assign or oncall_am != 'none' or oncall_pm != 'none':
                key = f"{sat_date.year}-{sat_date.month}-{sat_date.day}-{person}"
                data[key] = {"am": sat_assign, "pm": sun_assign,
                             "oncall_am": oncall_am, "oncall_pm": oncall_pm}

    return data


# ── Debug helper ──────────────────────────────────────────────────────────────

def debug_sheet(sheet_obj, month=1):
    grid_data = sheet_obj.get("data", [{}])[0]
    rows = grid_data.get("rowData", [])
    blocks = find_week_blocks(rows)
    print(f"  Total rows: {len(rows)}, week blocks found: {len(blocks)}")

    # Show every row that has any content (value or color) within the grid
    print("\n  All non-empty rows (cols 0-17):")
    for i, row in enumerate(rows):
        vals = [get_cell(row, c)[0] for c in range(18)]
        colors = {c: get_cell(row, c)[1] for c in range(18) if get_cell(row, c)[1]}
        if any(vals) or colors:
            print(f"    row {i:3d}: {vals}  colors={list(colors.keys()) if colors else ''}")
        if i > 120:
            print("    (truncated at row 120)")
            break


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    debug = "--debug" in sys.argv
    api_key = next(a for a in sys.argv[1:] if not a.startswith("--"))

    print(f"Fetching spreadsheet {SPREADSHEET_ID} ...")
    full = fetch_spreadsheet(api_key)

    sheets_by_name = {
        s["properties"]["title"].lower(): s
        for s in full.get("sheets", [])
    }
    print(f"Sheets found: {list(sheets_by_name.keys())}")

    if debug:
        # Usage: --debug [month_name]  e.g. --debug may
        debug_month = next((a for a in sys.argv[2:] if not a.startswith("--")), "jan")
        sheet = sheets_by_name.get(debug_month)
        if sheet:
            print(f"\n── DEBUG: {debug_month} sheet ──")
            debug_sheet(sheet)
        else:
            print(f"Sheet '{debug_month}' not found. Available: {list(sheets_by_name.keys())}")
        sys.exit(0)

    all_data = {}
    for sheet_name, month in SHEETS_TO_MONTHS.items():
        sheet = sheets_by_name.get(sheet_name)
        if not sheet:
            print(f"  WARNING: sheet '{sheet_name}' not found — skipping")
            continue
        print(f"  Parsing {sheet_name} (month {month})...", end=" ", flush=True)
        month_data = parse_sheet(sheet_name, sheet, month)
        all_data.update(month_data)
        print(f"{len(month_data)} assignments")

    output = {"data": all_data, "bariCall": {}}

    outfile = "call-calendar-import.json"
    with open(outfile, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n✓ {len(all_data)} total assignments → {outfile}")
    print("Next: Settings > Import data from JSON  (admin account required)")


if __name__ == "__main__":
    main()
