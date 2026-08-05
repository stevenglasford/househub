# server

Express API and static host for the built front-end.

See the [root README](../README.md) for setup, deployment, and the full API reference.

- `server.js` — routes, static hosting, background calendar refresh
- `ics.js` — iCalendar parsing, recurrence and multi-day expansion
- `store.js` — JSON-file datastore with atomic writes
- `data.json` — created on first run; this is your household's data (gitignored)

```bash
npm install
npm start          # http://localhost:4000
```

The front-end must be built first (`npm run build` from the repo root), which outputs
into `server/public/`. Without it the API works but there's no UI to serve.
