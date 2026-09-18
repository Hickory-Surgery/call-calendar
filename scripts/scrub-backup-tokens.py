#!/usr/bin/env python3
"""Blank out secret feed-token columns in a pg_dump --data-only SQL file, in place.

staff.feed_token and company_info.call_feed_token authorize the iCal feed
endpoints and must not end up in the weekly backup artifact (public repo,
90-day retention). Everything else in those tables is kept.

Fails loudly if either target table/column isn't found in the dump, so a
future schema change doesn't silently stop scrubbing the tokens.
"""
import re
import sys

TARGETS = {
    "public.staff": "feed_token",
    "public.company_info": "call_feed_token",
}


def scrub(path):
    with open(path) as f:
        lines = f.readlines()

    out = []
    active_index = None
    found = set()
    for line in lines:
        m = re.match(r"COPY (\S+) \(([^)]*)\) FROM stdin;", line)
        if m:
            table = m.group(1)
            cols = [c.strip() for c in m.group(2).split(",")]
            target_col = TARGETS.get(table)
            if target_col is not None:
                if target_col not in cols:
                    sys.exit(
                        f"scrub-backup-tokens: expected column '{target_col}' "
                        f"not found in {table} — schema changed, update TARGETS"
                    )
                active_index = cols.index(target_col)
                found.add(table)
            else:
                active_index = None
            out.append(line)
            continue
        if line.startswith("\\."):
            active_index = None
            out.append(line)
            continue
        if active_index is not None:
            fields = line.rstrip("\n").split("\t")
            fields[active_index] = "\\N"
            out.append("\t".join(fields) + "\n")
            continue
        out.append(line)

    missing = set(TARGETS) - found
    if missing:
        sys.exit(
            f"scrub-backup-tokens: expected table(s) not found in dump: "
            f"{', '.join(sorted(missing))} — update TARGETS or check --exclude-table flags"
        )

    with open(path, "w") as f:
        f.writelines(out)


if __name__ == "__main__":
    scrub(sys.argv[1])
