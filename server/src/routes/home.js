// home.js — the Home Assistant bridge: setup, reading, and control.
//
// Configuration is per household. It used to be two server-wide environment
// variables, which meant every household on a shared server saw the same house.
//
// Control is split by consequence rather than switched on wholesale:
//
//   light, switch, fan, cover   a display may operate these, if granted
//   lock                        signed-in members only, always, no exceptions
//
// The lock rule is checked against the *caller*, not against the display's
// stored capability list, so no configuration -- and no future well-meaning
// patch to that list -- can put the front door on a screen mounted next to it.
// A wall tablet that can unlock the front door is a keypad with no code.
//
// Authorisation is always decided before configuration is consulted. Otherwise
// the lock refusal quietly becomes "Home Assistant is not set up" on a server
// without it, and the rule looks like it is working while never being reached.

import express from "express";
import { z } from "zod";

import { q } from "../db/pool.js";
import { wrap, badRequest, forbidden, notFound, ApiError } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import { requireAuth, loadHousehold, requireRole, atLeast, requireWritable } from "../middleware/auth.js";
import { seal, openText } from "../crypto/seal.js";
import * as ha from "../services/homeassistant.js";
import { audit } from "../services/audit.js";

// mergeParams, because this router is mounted under
// /api/households/:householdId/home -- without it, loadHousehold() sees no
// householdId and every request 404s.
export const memberRouter = express.Router({ mergeParams: true });
export const displayRouter = express.Router();

const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest(r.error.issues[0].message);
  return r.data;
};

const controlSchema = z.object({
  entityId: z.string().min(3).max(120).regex(/^[a-z_]+\.[a-z0-9_]+$/i, "That is not an entity id"),
  action: z.enum(["on", "off", "toggle"]).default("toggle"),
});

/**
 * Load a household's connection and unseal it.
 *
 * Returns null when the household has not connected Home Assistant, which is
 * the ordinary case and not an error -- the Home tab simply does not appear.
 */
async function connectionFor(householdId) {
  const { rows } = await q(
    `SELECT url_enc, token_enc, dashboard_enc, entities, control_enabled
       FROM household_home_assistant WHERE household_id = $1`,
    [householdId]
  );
  if (!rows[0]) return null;
  try {
    return {
      url: openText("haUrl", rows[0].url_enc, householdId),
      token: openText("haToken", rows[0].token_enc, householdId),
      dashboard: rows[0].dashboard_enc ? openText("haDashboard", rows[0].dashboard_enc, householdId) : null,
      entities: rows[0].entities || [],
      controlEnabled: rows[0].control_enabled,
    };
  } catch {
    // Sealed under a server key that no longer opens it. Treat as unconfigured
    // rather than failing every request in the household.
    return null;
  }
}

const required = (conn) => {
  if (!conn) throw new ApiError(503, "ha_unconfigured", "Home Assistant is not connected for this household");
  return conn;
};

/* ============================================================ setup ======= */

/** Whether it is connected, and what the household chose to show. */
memberRouter.get("/", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT entities, control_enabled, last_ok_at, last_error, dashboard_enc, url_enc
       FROM household_home_assistant WHERE household_id = $1`,
    [req.household.id]
  );
  if (!rows[0]) return res.json({ connected: false });

  res.json({
    connected: true,
    // The URL is shown back so somebody can see which instance is connected;
    // the token never is, under any circumstances.
    url: (() => { try { return openText("haUrl", rows[0].url_enc, req.household.id); } catch { return null; } })(),
    dashboardUrl: rows[0].dashboard_enc
      ? (() => { try { return openText("haDashboard", rows[0].dashboard_enc, req.household.id); } catch { return null; } })()
      : null,
    entities: rows[0].entities || [],
    controlEnabled: rows[0].control_enabled,
    lastOkAt: rows[0].last_ok_at,
    lastError: rows[0].last_error,
    memberOnlyDomains: ha.MEMBER_ONLY_DOMAINS,
    displayControllable: ha.DISPLAY_CONTROLLABLE,
  });
}));

/**
 * Try a URL and token without saving them.
 *
 * Setup fails often -- wrong port, wrong protocol, a token pasted with a
 * newline -- and a "test" button that reports what it actually found turns a
 * frustrating half hour into thirty seconds.
 */
memberRouter.post("/test",
  requireAuth, loadHousehold(), requireRole("admin"),
  limit("ha-test", { capacity: 20, perSecond: 0.1, by: "household" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      url: z.string().url().max(500),
      token: z.string().min(20).max(4000),
    }), req.body);

    try {
      res.json(await ha.testConnection({ url: body.url.trim(), token: body.token.trim() }));
    } catch (err) {
      // A failed test is expected, not exceptional. 200 with ok:false so the UI
      // can show the reason inline instead of an error page.
      res.json({ ok: false, error: err.message });
    }
  })
);

memberRouter.put("/",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  limit("ha-configure", { capacity: 20, perSecond: 0.05, by: "household" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      url: z.string().url().max(500),
      // Omitted when only the entity selection is changing, so nobody has to
      // paste a long-lived token again to tick a checkbox.
      token: z.string().min(20).max(4000).optional(),
      dashboardUrl: z.string().url().max(500).nullable().optional(),
      entities: z.array(z.string().max(120)).max(200).optional(),
      controlEnabled: z.boolean().optional(),
    }), req.body);

    const url = body.url.trim();
    await ha.assertReachableTarget(url).catch((e) => { throw badRequest(e.message); });

    const existing = await connectionFor(req.household.id);
    const token = body.token?.trim() || existing?.token;
    if (!token) throw badRequest("An access token is needed the first time you connect");

    // Verified before storing: a saved-but-broken integration is worse than no
    // integration, because it looks connected.
    try {
      await ha.testConnection({ url, token });
    } catch (err) {
      throw badRequest(`Could not connect: ${err.message}`);
    }

    await q(
      `INSERT INTO household_home_assistant
         (household_id, url_enc, token_enc, dashboard_enc, entities, control_enabled,
          configured_by, last_ok_at, last_error, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7, now(), NULL, now())
       ON CONFLICT (household_id) DO UPDATE SET
         url_enc        = EXCLUDED.url_enc,
         token_enc      = EXCLUDED.token_enc,
         dashboard_enc  = COALESCE(EXCLUDED.dashboard_enc, household_home_assistant.dashboard_enc),
         entities       = COALESCE(EXCLUDED.entities, household_home_assistant.entities),
         control_enabled = EXCLUDED.control_enabled,
         configured_by  = EXCLUDED.configured_by,
         last_ok_at     = now(), last_error = NULL, updated_at = now()`,
      [
        req.household.id,
        seal("haUrl", url, req.household.id),
        seal("haToken", token, req.household.id),
        body.dashboardUrl ? seal("haDashboard", body.dashboardUrl, req.household.id) : null,
        body.entities ? JSON.stringify(body.entities) : null,
        body.controlEnabled ?? false,
        req.user.id,
      ]
    );
    ha.invalidate(req.household.id);

    await audit("ha_configured", {
      householdId: req.household.id, actorUserId: req.user.id,
      meta: { entities: body.entities?.length ?? null, control: body.controlEnabled ?? false },
    });
    res.json({ ok: true });
  })
);

memberRouter.delete("/",
  requireAuth, loadHousehold(), requireRole("admin"),
  wrap(async (req, res) => {
    await q("DELETE FROM household_home_assistant WHERE household_id = $1", [req.household.id]);
    ha.invalidate(req.household.id);
    await audit("ha_disconnected", { householdId: req.household.id, actorUserId: req.user.id });
    res.json({
      ok: true,
      note: "The access token has been deleted from this server. Revoke it in Home Assistant too.",
    });
  })
);

/* -------------------------------------------------- device management ----- */

/**
 * The household's own names, rooms and ordering for its devices.
 *
 * Home Assistant will not let us create a device -- pairing happens in its own
 * config flow, which is the right place for it. Everything after that is fair
 * game, and is what actually makes a wall display readable: a household is never
 * going to rename `sensor.0x00158d0004a1b2c3_temperature` upstream, but they
 * will happily call it "Greenhouse" here.
 */
async function readDevices(householdId) {
  const { rows } = await q(
    "SELECT devices_enc FROM household_home_assistant WHERE household_id = $1", [householdId]
  );
  if (!rows[0]?.devices_enc) return { rooms: [], overrides: {} };
  try {
    const parsed = JSON.parse(openText("haDevices", rows[0].devices_enc, householdId));
    return { rooms: parsed.rooms || [], overrides: parsed.overrides || {} };
  } catch {
    return { rooms: [], overrides: {} };
  }
}

/**
 * Entities with the household's overrides applied, grouped into rooms.
 *
 * One call, because every screen that shows devices needs exactly this and
 * making each of them merge two responses is how they drift apart.
 */
memberRouter.get("/devices", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const conn = required(await connectionFor(req.household.id));
  const { rooms, overrides } = await readDevices(req.household.id);

  const live = await ha.getStates(conn, req.household.id, conn.entities);
  const merged = live
    .map((e) => {
      const o = overrides[e.entityId] || {};
      return {
        ...e,
        // The household's name wins; Home Assistant's is kept so the settings
        // screen can show what it is actually called upstream.
        name: o.name || e.name,
        haName: e.name,
        room: o.room || null,
        order: Number.isFinite(o.order) ? o.order : 9999,
        hidden: Boolean(o.hidden),
        controllable: ha.isControllable(e.entityId) && conn.controlEnabled,
        memberOnly: ha.MEMBER_ONLY_DOMAINS.includes(e.domain),
      };
    })
    .filter((e) => !e.hidden)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  // Rooms in the household's own order, with anything unassigned last.
  const byRoom = [
    ...rooms.map((r) => ({ room: r, entities: merged.filter((e) => e.room === r) })),
    { room: null, entities: merged.filter((e) => !e.room || !rooms.includes(e.room)) },
  ].filter((g) => g.entities.length);

  res.json({ rooms, groups: byRoom, entities: merged, controlEnabled: conn.controlEnabled });
}));

memberRouter.put("/devices",
  requireAuth, loadHousehold(), atLeast("adult"), requireWritable,
  limit("ha-devices", { capacity: 60, perSecond: 0.5, by: "household" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      rooms: z.array(z.string().trim().min(1).max(40)).max(40).optional(),
      overrides: z.record(
        z.string().max(120),
        z.object({
          name: z.string().trim().max(60).optional(),
          room: z.string().trim().max(40).nullable().optional(),
          order: z.number().int().min(0).max(99999).optional(),
          hidden: z.boolean().optional(),
        }).strict()
      ).optional(),
    }).strict(), req.body);

    const current = await readDevices(req.household.id);
    const next = {
      rooms: body.rooms ?? current.rooms,
      // Merged rather than replaced, so renaming one lamp does not wipe the rest.
      overrides: { ...current.overrides, ...(body.overrides || {}) },
    };
    // An override that says nothing is just clutter.
    for (const [id, o] of Object.entries(next.overrides)) {
      if (!o || (!o.name && !o.room && o.order === undefined && !o.hidden)) delete next.overrides[id];
    }

    await q(
      "UPDATE household_home_assistant SET devices_enc = $2, updated_at = now() WHERE household_id = $1",
      [req.household.id, seal("haDevices", JSON.stringify(next), req.household.id)]
    );
    await audit("ha_devices_organised", {
      householdId: req.household.id, actorUserId: req.user.id,
      meta: { rooms: next.rooms.length, overrides: Object.keys(next.overrides).length },
    });
    res.json({ ok: true, rooms: next.rooms });
  })
);

/**
 * The display's device view: the same rooms and names, read-only in structure.
 *
 * A screen shows what the household organised; it cannot reorganise it.
 */
displayRouter.get("/devices",
  limit("display-ha-devices", { capacity: 120, perSecond: 1 }),
  wrap(async (req, res) => {
    if (!req.display.scopes.includes("home")) {
      throw forbidden("This display is not permitted to show the home view");
    }
    const conn = required(await connectionFor(req.display.household_id));
    const { rooms, overrides } = await readDevices(req.display.household_id);
    const granted = Array.isArray(req.display.control_domains) ? req.display.control_domains : [];

    const live = await ha.getStates(conn, req.display.household_id, conn.entities);
    const merged = live
      .map((e) => {
        const o = overrides[e.entityId] || {};
        return {
          ...e,
          name: o.name || e.name,
          room: o.room || null,
          order: Number.isFinite(o.order) ? o.order : 9999,
          hidden: Boolean(o.hidden),
          // What this screen may actually touch. Locks are never in `granted`,
          // and routes/home.js refuses them regardless of what is stored.
          controllable: conn.controlEnabled
            && granted.includes(e.domain)
            && !ha.MEMBER_ONLY_DOMAINS.includes(e.domain),
        };
      })
      .filter((e) => !e.hidden)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

    const byRoom = [
      ...rooms.map((r) => ({ room: r, entities: merged.filter((e) => e.room === r) })),
      { room: null, entities: merged.filter((e) => !e.room || !rooms.includes(e.room)) },
    ].filter((g) => g.entities.length);

    res.json({ rooms, groups: byRoom, entities: merged });
  })
);

/** Everything available, for the entity picker. */
memberRouter.get("/entities/all",
  requireAuth, loadHousehold(), requireRole("admin"),
  limit("ha-list", { capacity: 30, perSecond: 0.2, by: "household" }),
  wrap(async (req, res) => {
    const conn = required(await connectionFor(req.household.id));
    res.json(await ha.listEntities(conn, { all: req.query.all === "1" }));
  })
);

/* =========================================================== members ====== */

memberRouter.get("/entities", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const conn = required(await connectionFor(req.household.id));
  res.json(await ha.getStates(conn, req.household.id, conn.entities));
}));

memberRouter.get("/camera/:entityId.jpg", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const conn = required(await connectionFor(req.household.id));
  if (conn.entities.length && !conn.entities.includes(req.params.entityId)) {
    throw forbidden("That camera is not one this household has chosen to show");
  }
  const snap = await ha.getSnapshot(conn, req.household.id, req.params.entityId);
  if (!snap) throw notFound("No image from that camera");
  res.type(snap.type).send(snap.buf);
}));

/**
 * Control anything, including locks.
 *
 * Adult or admin only. A dependant's account should not be unlocking the front
 * door, and a viewer is read-only.
 */
memberRouter.post("/control",
  requireAuth, loadHousehold(), atLeast("adult"), requireWritable,
  limit("ha-control", { capacity: 60, perSecond: 0.5, by: "user" }),
  wrap(async (req, res) => {
    const body = parse(controlSchema, req.body);
    if (!ha.isControllable(body.entityId)) {
      throw badRequest("That kind of device cannot be switched from HouseHub");
    }

    const conn = required(await connectionFor(req.household.id));
    if (!conn.controlEnabled) {
      throw forbidden("Control is switched off for this household. An admin can enable it.");
    }

    try {
      const out = await ha.callService(conn, req.household.id, body.entityId, body.action);
      // Locks get their own action name: who opened the door and when is worth
      // being able to answer later.
      await audit(ha.MEMBER_ONLY_DOMAINS.includes(out.domain) ? "ha_lock_operated" : "ha_controlled", {
        householdId: req.household.id, actorUserId: req.user.id,
        target: body.entityId, meta: { action: body.action, via: "member" },
      });
      res.json(out);
    } catch (err) {
      await q("UPDATE household_home_assistant SET last_error = $2 WHERE household_id = $1",
        [req.household.id, err.message.slice(0, 300)]);
      throw new ApiError(502, "ha_failed", err.message);
    }
  })
);

/* ========================================================== displays ====== */

displayRouter.get("/entities",
  limit("display-ha-entities", { capacity: 120, perSecond: 1 }),
  wrap(async (req, res) => {
    if (!req.display.scopes.includes("home")) {
      throw forbidden("This display is not permitted to show the home view");
    }
    const conn = required(await connectionFor(req.display.household_id));
    res.json(await ha.getStates(conn, req.display.household_id, conn.entities));
  })
);

displayRouter.get("/camera/:entityId.jpg",
  limit("display-camera", { capacity: 300, perSecond: 3 }),
  wrap(async (req, res) => {
    if (!req.display.scopes.includes("home")) throw forbidden("Not permitted on this display");
    const conn = required(await connectionFor(req.display.household_id));
    if (conn.entities.length && !conn.entities.includes(req.params.entityId)) {
      throw forbidden("That camera is not one this household has chosen to show");
    }
    const snap = await ha.getSnapshot(conn, req.display.household_id, req.params.entityId);
    if (!snap) throw notFound("No image from that camera");
    res.type(snap.type).send(snap.buf);
  })
);

/**
 * Control, from a display.
 *
 * Three gates, and the first is the one that matters most: a lock is refused
 * before anything else is even looked at.
 */
displayRouter.post("/control",
  limit("display-ha-control", { capacity: 60, perSecond: 0.5 }),
  wrap(async (req, res) => {
    const body = parse(controlSchema, req.body);
    const domain = ha.domainOf(body.entityId);

    if (ha.MEMBER_ONLY_DOMAINS.includes(domain)) {
      throw forbidden(
        `${domain === "lock" ? "Locks" : "That"} can only be operated by someone signed in. ` +
        "Open HouseHub on your phone."
      );
    }
    const granted = Array.isArray(req.display.control_domains) ? req.display.control_domains : [];
    if (!granted.includes(domain)) {
      throw forbidden(`This display has not been given control of ${domain}s`);
    }
    if (!ha.isControllable(body.entityId)) {
      throw badRequest("That kind of device cannot be switched from HouseHub");
    }

    const conn = required(await connectionFor(req.display.household_id));
    if (!conn.controlEnabled) throw forbidden("Control is switched off for this household");

    try {
      const out = await ha.callService(conn, req.display.household_id, body.entityId, body.action);
      await audit("ha_controlled", {
        householdId: req.display.household_id, target: body.entityId,
        meta: { action: body.action, via: "display", display: req.display.name },
      });
      res.json(out);
    } catch (err) {
      throw new ApiError(502, "ha_failed", err.message);
    }
  })
);

export default { memberRouter, displayRouter };
