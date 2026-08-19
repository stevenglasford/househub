#!/usr/bin/env python3
"""Build the legacy-database fixture used by web/test/legacy-import.test.js.

    python3 web/test/fixtures/make-legacy-db.py

WHY PYTHON, IN A JAVASCRIPT PROJECT

The thing under test is a hand-written SQLite reader (web/src/lib/sqlite.js).
A fixture produced by our own code would only prove the reader agrees with our
writer, which is worth nothing. Python's `sqlite3` module is the reference
SQLite implementation, is in the standard library, and is already present on
every machine this project is developed on -- so the fixture is a genuine
SQLite file written by SQLite itself.

The schema below is copied from the old app's store.js. It is deliberately
awkward in three specific ways, because those are what a real household
database does and what a naive reader gets wrong:

  * a table big enough to need interior B-tree pages (400 chores)
  * rows too big for one page, forcing overflow chains (a 40 KB .ics body)
  * a `pos` order that disagrees with rowid order, because the household
    reordered its grocery list by dragging
"""

import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "legacy.db")

LISTS = [
    "people", "events", "chores", "tasks", "grocery", "notes", "dates",
    "projects", "agenda", "agendaArchive", "agendaPrompts", "dateJars", "dateIdeas",
]


def main():
    if os.path.exists(OUT):
        os.remove(OUT)
    db = sqlite3.connect(OUT)

    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT NOT NULL)")
    for table in LISTS:
        db.execute(
            f'CREATE TABLE IF NOT EXISTS "{table}" '
            "(id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL)"
        )
    db.execute("CREATE TABLE IF NOT EXISTS meals (date TEXT PRIMARY KEY, data TEXT NOT NULL)")
    db.execute(
        "CREATE TABLE IF NOT EXISTS calendars "
        "(id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL, "
        "ics_text TEXT NOT NULL DEFAULT '')"
    )

    people = [
        {"id": "p1", "name": "Steven", "color": "#5D6FE0"},
        {"id": "p2", "name": "Alex", "color": "#2E9187"},
    ]
    for i, person in enumerate(people):
        db.execute("INSERT INTO people VALUES (?,?,?)", (person["id"], i, json.dumps(person)))

    # Enough rows to push the table past a single leaf page, and a fat `done`
    # map so each row is substantial.
    for i in range(400):
        chore = {
            "id": f"c{i}",
            "title": f"Chore number {i} with a reasonably long title to bulk the row out",
            "personId": "p1" if i % 2 else "p2",
            "cadence": {"type": "daily"},
            "done": {f"2026-08-{d:02d}": ("p1" if d % 2 else "skipped") for d in range(1, 29)},
        }
        db.execute("INSERT INTO chores VALUES (?,?,?)", (chore["id"], i, json.dumps(chore)))

    for i in range(30):
        task = {"id": f"t{i}", "title": f"Task {i}", "date": "2026-08-12",
                "personId": "p2", "done": i % 3 == 0}
        db.execute("INSERT INTO tasks VALUES (?,?,?)", (task["id"], i, json.dumps(task)))

    # Inserted in one order, positioned in another -- exactly what dragging an
    # item up the list did in the old app. A reader that trusts rowid order
    # returns these shuffled, and plausibly enough that nobody notices.
    groceries = ["Milk", "Bread", "Eggs", "Butter", "Coffee", "Rice",
                 "Onions", "Cheese", "Apples", "Pasta", "Tomatoes", "Soap"]
    insertion_order = [7, 0, 11, 3, 9, 1, 5, 10, 2, 8, 4, 6]
    for row_number, pos in enumerate(insertion_order):
        item = {"id": f"g{pos}", "title": groceries[pos], "done": False, "aisle": "Other"}
        db.execute("INSERT INTO grocery VALUES (?,?,?)", (item["id"], pos, json.dumps(item)))

    note = {"id": "n1", "text": "Ring the plumber — ask about the £120 quote ✅",
            "color": "#F6C177", "personId": "p1", "at": 1750000000}
    db.execute("INSERT INTO notes VALUES (?,?,?)", ("n1", 0, json.dumps(note)))

    db.execute("INSERT INTO meta VALUES (?,?)", ("householdName", json.dumps("Glasford House")))
    db.execute("INSERT INTO meta VALUES (?,?)", ("weather", json.dumps(
        {"lat": 44.98, "lon": -93.27, "label": "Minneapolis", "unit": "fahrenheit"})))
    db.execute("INSERT INTO meta VALUES (?,?)", ("checkin", json.dumps(
        {"offsetMinutes": 45, "soundOn": True,
         "log": {"2026-08-01": {"p1": {"happiness": 4, "connection": 5}}}})))
    db.execute("INSERT INTO meta VALUES (?,?)", ("showBreakdown", json.dumps(True)))
    # A credential the import must refuse to carry over.
    db.execute("INSERT INTO meta VALUES (?,?)", ("apiToken", json.dumps("legacy-secret-token")))

    # The pre-migration meals shape: one dish per slot, cooks and times hanging
    # off the day rather than off the dish.
    db.execute("INSERT INTO meals VALUES (?,?)", ("2026-08-10", json.dumps(
        {"dinner": "Roast chicken", "cooks": {"dinner": "p1"}, "times": {"dinner": "18:30"}})))

    # ~44 KB of iCalendar, which is ten pages' worth: this row must overflow.
    ics = "BEGIN:VCALENDAR\n" + "".join(
        f"BEGIN:VEVENT\nUID:e{i}\nSUMMARY:Imported event {i}\n"
        f"DTSTART;VALUE=DATE:2026081{i % 10}\nEND:VEVENT\n"
        for i in range(500)
    ) + "END:VCALENDAR"
    db.execute("INSERT INTO calendars VALUES (?,?,?,?)", (
        "cal1", 0,
        json.dumps({"id": "cal1", "name": "Work", "color": "#C98A2B",
                    "url": "https://example.com/f.ics"}),
        ics,
    ))

    db.commit()
    db.close()

    size = os.path.getsize(OUT)
    print(f"wrote {OUT} ({size} bytes, {len(ics)} bytes of iCalendar)")

    make_wal_pair()


def make_wal_pair():
    """A database copied while its server was still running.

    The old store ran SQLite in WAL mode, so this is what a person actually
    ends up with when they copy househub.db off a live machine: a main file
    holding an older household, and a -wal holding everything since. Reading
    the main file alone succeeds and silently returns the older data, which is
    the single most dangerous way this import could fail.
    """
    import shutil

    live = os.path.join(HERE, "live.db")
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(live + suffix):
            os.remove(live + suffix)

    db = sqlite3.connect(live)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, json TEXT NOT NULL)")
    db.execute("CREATE TABLE chores (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL)")
    db.execute("INSERT INTO meta VALUES ('householdName', ?)", (json.dumps("Before the copy"),))
    db.commit()
    # Force everything so far into the main file, so the -wal holds only what
    # follows and the two really do disagree.
    db.execute("PRAGMA wal_checkpoint(FULL)")
    db.commit()

    db.execute("UPDATE meta SET json=? WHERE key='householdName'", (json.dumps("After the copy"),))
    for i in range(40):
        chore = {"id": f"late{i}", "title": f"Added just before the copy {i}", "done": {}}
        db.execute("INSERT INTO chores VALUES (?,?,?)", (chore["id"], i, json.dumps(chore)))
    db.commit()

    # Copy while the connection is open — closing would checkpoint and hide it.
    shutil.copy(live, os.path.join(HERE, "live-copy.db"))
    shutil.copy(live + "-wal", os.path.join(HERE, "live-copy.db-wal"))
    db.close()
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(live + suffix):
            os.remove(live + suffix)

    print(f"wrote {os.path.join(HERE, 'live-copy.db')} + -wal (a live copy)")


if __name__ == "__main__":
    sys.exit(main())
