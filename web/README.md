# web

React + Vite + Tailwind front-end. The entire UI is `src/App.jsx`; `src/api.js` is a
thin REST client over the backend.

```bash
npm install
npm run dev        # :5173, proxies /api to localhost:4000
npm run build      # outputs into ../server/public/
```

Set `API_TARGET` if the backend isn't on `localhost:4000` during development.

See the [root README](../README.md) for everything else.
