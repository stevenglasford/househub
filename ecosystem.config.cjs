// pm2 process definition for the Household Hub.
//
//   pm2 start ecosystem.config.cjs
//   pm2 save                          # persist across reboots (with pm2 startup)
//
// Env lives here rather than in a .env file — pm2 is the source of truth in
// production. Logs land in ~/.pm2/logs/hub-{out,error}.log as usual.

const { join } = require("node:path");

module.exports = {
  apps: [
    {
      name: "hub",
      cwd: join(__dirname, "server"),
      script: "server.js",
      env: {
        NODE_ENV: "production",
        PORT: 4000,
        REFRESH_MINUTES: 15,
        TZ: "America/Chicago",
        // Point at a path OUTSIDE the repo so redeploys can't touch your data.
        // Default if unset: server/hub.db
        DB_FILE: "/var/lib/household-hub/hub.db",
        // Optional read-only Home Assistant integration. The token stays here
        // on the server and is never sent to the browser.
        // HA_URL: "http://192.168.1.50:8123",
        // HA_TOKEN: "",
        // Any variable from .env.example can be set here — see that file for
        // the full list (weather location, seed household, display defaults).
      },
      max_memory_restart: "300M",
      restart_delay: 5000,
      kill_timeout: 5000,
      time: true, // timestamp pm2 log lines
    },
  ],
};
