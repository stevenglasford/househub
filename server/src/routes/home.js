// home.js — the Home Assistant bridge, for members and for displays.
//
// Reading state is uncontroversial and available to both. Controlling something
// is split by consequence, which is the part worth being deliberate about:
//
//   light, switch, fan, cover   a display may operate these, if granted
//   lock                        signed-in members only, always, no exceptions
//
// The lock rule is enforced here against the caller rather than by the
// display's capability list, so there is no configuration -- and no future
// well-meaning patch to that list -- that can put the front door on a screen in
// the hallway. A wall tablet that can unlock the front door is a keypad with no
// code, mounted next to the thing it opens.
//
// Everything a display can do is still bounded by its granted domains, its
// expiry, and revocation.

import express from "express";
import { z } from "zod";

import { wrap, badRequest, forbidden, notFound, ApiError } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import { requireAuth, loadHousehold, atLeast } from "../middleware/auth.js";
import * as ha from "../services/homeassistant.js";
import { audit } from "../services/audit.js";

export const memberRouter = express.Router();
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

function ensureConfigured() {
  if (!ha.isConfigured()) {
    throw new ApiError(503, "ha_unconfigured", "Home Assistant is not set up on this server");
  }
}

/* =============================================================== members === */

memberRouter.get("/status", requireAuth, wrap(async (req, res) => {
  if (!ha.isConfigured()) return res.json({ configured: false });
  try {
    await ha.ping();
    res.json({ configured: true, reachable: true, memberOnlyDomains: ha.MEMBER_ONLY_DOMAINS });
  } catch (err) {
    res.json({ configured: true, reachable: false, error: err.message });
  }
}));

memberRouter.get("/entities", requireAuth, loadHousehold(), wrap(async (req, res) => {
  ensureConfigured();
  const only = req.query.only ? String(req.query.only).split(",").slice(0, 200) : null;
  res.json(await ha.getStates({ only, allDomains: req.query.all === "1" }));
}));

memberRouter.get("/camera/:entityId.jpg", requireAuth, loadHousehold(), wrap(async (req, res) => {
  ensureConfigured();
  const snap = await ha.getSnapshot(req.params.entityId);
  if (!snap) throw notFound("No image from that camera");
  res.type(snap.type || "image/jpeg").send(snap.buf);
}));

/**
 * Control anything Home Assistant exposes, including locks.
 *
 * A signed-in member with at least adult access. Dependants and viewers are
 * excluded: a child's account should not be unlocking the front door, and a
 * read-only member is read-only.
 */
memberRouter.post("/control",
  requireAuth, loadHousehold(), atLeast("adult"),
  limit("ha-control", { capacity: 60, perSecond: 0.5, by: "user" }),
  wrap(async (req, res) => {
    const body = parse(controlSchema, req.body);
    if (!ha.isControllable(body.entityId)) {
      throw badRequest("That kind of device cannot be switched from HouseHub");
    }
    ensureConfigured();

    try {
      const out = await ha.callService(body.entityId, body.action);
      // Locks are logged individually: who opened the door and when is worth
      // being able to answer later.
      await audit(
        ha.MEMBER_ONLY_DOMAINS.includes(out.domain) ? "ha_lock_operated" : "ha_controlled",
        {
          householdId: req.household.id, actorUserId: req.user.id,
          target: body.entityId, meta: { action: body.action, via: "member" },
        }
      );
      res.json(out);
    } catch (err) {
      throw new ApiError(502, "ha_failed", err.message);
    }
  })
);

/* ============================================================== displays === */

/**
 * The read side for a screen: state and camera stills.
 *
 * Deliberately open to anyone standing in front of the tablet -- checking
 * whether the dogs are in the garden is the ordinary use, and requiring a login
 * for it would mean nobody ever uses the screen.
 */
displayRouter.get("/entities",
  limit("display-ha-entities", { capacity: 120, perSecond: 1 }),
  wrap(async (req, res) => {
    if (!req.display.scopes.includes("home")) {
      throw forbidden("This display is not permitted to show the home view");
    }
    ensureConfigured();
    res.json(await ha.getStates({ only: null }));
  })
);

displayRouter.get("/camera/:entityId.jpg",
  limit("display-camera", { capacity: 300, perSecond: 3 }),
  wrap(async (req, res) => {
    if (!req.display.scopes.includes("home")) throw forbidden("Not permitted on this display");
    ensureConfigured();
    const snap = await ha.getSnapshot(req.params.entityId);
    if (!snap) throw notFound("No image from that camera");
    res.type(snap.type || "image/jpeg").send(snap.buf);
  })
);

/**
 * Control, from a display.
 *
 * Two independent gates, and the second is the one that matters:
 *
 *   1. the domain must be in this display's granted list
 *   2. the domain must not be member-only -- checked here rather than trusting
 *      the granted list, so a lock can never be reachable from a screen even if
 *      one is somehow written into the database
 */
displayRouter.post("/control",
  limit("display-ha-control", { capacity: 60, perSecond: 0.5 }),
  wrap(async (req, res) => {
    // Authorisation first, configuration second. Deciding "may this caller do
    // this at all" must not depend on whether Home Assistant happens to be set
    // up -- otherwise the lock refusal silently becomes a 503 on a server
    // without HA, and the rule looks like it is working when it is not being
    // reached. It also avoids telling an unauthorised caller anything about how
    // the server is configured.
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
    ensureConfigured();

    try {
      const out = await ha.callService(body.entityId, body.action);
      await audit("ha_controlled", {
        householdId: req.display.household_id,
        target: body.entityId,
        meta: { action: body.action, via: "display", display: req.display.name },
      });
      res.json(out);
    } catch (err) {
      throw new ApiError(502, "ha_failed", err.message);
    }
  })
);

export default { memberRouter, displayRouter };
