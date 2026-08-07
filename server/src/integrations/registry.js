// registry.js — integrations a household can plug in.
//
// HouseHub and Home Assistant are two separate systems. A family runs their own
// Home Assistant, on their own hardware, and connects it to their household
// here. HouseHub never bundles it, never proxies it for anyone else, and holds
// nothing about it beyond the address and token that household supplied.
//
// This registry exists so that "Home Assistant" is a plugin rather than a
// special case welded into the app. Everything a household-level integration
// needs to describe itself lives in one manifest:
//
//   - what it is, and what it will be able to see
//   - where its settings live
//   - how to answer "is this household connected?"
//
// Adding another -- a music system, a printer, an energy monitor -- is a new
// entry here plus its routes. Nothing else in the app needs to learn about it,
// and crucially nothing about the encryption changes: an integration is
// server-side plumbing to somebody else's system, and it never touches the
// household vault.

import { q } from "../db/pool.js";

/**
 * Integrations are per household, never per server.
 *
 * That is the correction this registry encodes. Home Assistant used to be two
 * environment variables, which on a server hosting several families showed all
 * of them the same house. A shared server must let each household plug in its
 * own instance and see only that.
 */
export const INTEGRATIONS = [
  {
    id: "home-assistant",
    name: "Home Assistant",
    summary: "Cameras, lights, sensors and locks from your own Home Assistant.",

    // What a household is agreeing to when they connect it. Shown in the UI
    // before setup, because "what will this server be able to reach" is the
    // question people should be asking and rarely are.
    grants: [
      "This server can read the state of the entities you choose",
      "This server can fetch camera stills, which it proxies to your screens",
      "If you enable control, this server can switch the devices you allow",
    ],
    holds: [
      "The address of your Home Assistant, encrypted",
      "A long-lived access token, encrypted — it is never sent back to a browser",
    ],
    notes: [
      "Your household's own data stays end-to-end encrypted. This integration is " +
      "separate plumbing to a separate system and never touches it.",
      "Locks can only be operated by a signed-in member with adult access, and never " +
      "from a shared display, whatever else is configured.",
    ],

    // Where its own routes live, so the client does not hardcode paths.
    basePath: "home",
    settingsComponent: "HomeAssistantPanel",

    docs: "https://github.com/stevenglasford/househub/blob/main/docs/HOME-ASSISTANT.md",

    /** Is this household connected, and is it healthy? */
    async status(householdId) {
      const { rows } = await q(
        `SELECT last_ok_at, last_error, control_enabled,
                jsonb_array_length(entities) AS entity_count
           FROM household_home_assistant WHERE household_id = $1`,
        [householdId]
      );
      if (!rows[0]) return { connected: false };
      return {
        connected: true,
        healthy: !rows[0].last_error,
        lastOkAt: rows[0].last_ok_at,
        lastError: rows[0].last_error,
        entityCount: rows[0].entity_count,
        controlEnabled: rows[0].control_enabled,
      };
    },
  },
  {
    id: "camwatch",
    name: "Security cameras (CamWatch)",
    summary: "Live cameras, alerts and recordings from your own CamWatch instance.",

    grants: [
      "This server can fetch live streams and snapshots and pass them to your screens",
      "It can read your alert history, if you enable it",
      "It can read enrolled faces and recordings, each switched on separately",
    ],
    holds: [
      "The address of your CamWatch, encrypted",
      "Its password, encrypted — never sent back to a browser",
      "No footage, no snapshots, no faces, no recordings. Everything is proxied " +
      "on demand and nothing is written to this server's disk.",
    ],
    notes: [
      "Face data is biometric information and stays on the machine that already " +
      "holds it. Surfacing it here is off by default and switched on separately.",
      "A wall display can be shown live cameras but never alerts, faces or " +
      "recordings — a screen in a hallway listing who came to the door is a " +
      "different thing from one showing the garden right now.",
    ],

    basePath: "cameras",
    settingsComponent: "CamerasPanel",
    docs: "https://github.com/stevenglasford/househub/blob/main/docs/CAMERAS.md",

    async status(householdId) {
      const { rows } = await q(
        `SELECT last_ok_at, last_error, show_faces, show_recordings,
                jsonb_array_length(cameras) AS camera_count
           FROM household_cameras WHERE household_id = $1`,
        [householdId]
      );
      if (!rows[0]) return { connected: false };
      return {
        connected: true,
        healthy: !rows[0].last_error,
        lastOkAt: rows[0].last_ok_at,
        lastError: rows[0].last_error,
        cameraCount: rows[0].camera_count,
        facesSurfaced: rows[0].show_faces,
        recordingsSurfaced: rows[0].show_recordings,
      };
    },
  },
];

export const byId = (id) => INTEGRATIONS.find((i) => i.id === id) || null;

/** Every integration, with this household's connection state resolved. */
export async function listForHousehold(householdId) {
  return Promise.all(
    INTEGRATIONS.map(async (i) => {
      let status;
      try {
        status = await i.status(householdId);
      } catch {
        // A broken integration must not break the settings page.
        status = { connected: false, error: "status unavailable" };
      }
      const { status: _fn, ...manifest } = i;
      return { ...manifest, status };
    })
  );
}
