# server

Express API and static host for the built front-end.

See the [root README](../README.md) for setup, deployment, and the full API reference.

- `server.js` — routes, static hosting, background calendar refresh
- `ics.js` — iCalendar parsing, recurrence and multi-day expansion
- `store.js` — SQLite datastore (better-sqlite3, WAL, one transaction per mutation)
- `backup.mjs` — WAL-safe online backup (`npm run backup`)
- `hub.db` — created on first run; this is your household's data (gitignored).
  An existing `data.json` from the old JSON store is imported automatically on
  first boot and renamed to `data.json.imported`.

```bash
npm install
npm start          # http://localhost:4000
```

The front-end must be built first (`npm run build` from the repo root), which outputs
into `server/public/`. Without it the API works but there's no UI to serve.
