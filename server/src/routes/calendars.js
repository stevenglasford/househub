// calendars.js — subscribed feed management. Thin by design; the work is in
// services/calendars.js and services/safe-fetch.js.

import express from "express";
import { z } from "zod";

import { wrap, badRequest, notFound } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import { requireAuth, loadHousehold, atLeast, requireWritable } from "../middleware/auth.js";
import { addFeed, removeFeed, listFeeds, refreshFeed, eventsFor } from "../services/calendars.js";
import { BlockedRequestError } from "../services/safe-fetch.js";
import { audit } from "../services/audit.js";

export const router = express.Router();

const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest(r.error.issues[0].message);
  return r.data;
};

router.get("/:householdId/calendars", requireAuth, loadHousehold(), wrap(async (req, res) => {
  res.json(await listFeeds(req.household.id));
}));

router.post("/:householdId/calendars",
  requireAuth, loadHousehold(), atLeast("adult"), requireWritable,
  // Each add makes an outbound request, so the limit is tight: this is the
  // endpoint an attacker would use to turn the server into a port scanner.
  limit("calendar-add", { capacity: 10, perSecond: 0.05, by: "household" }),
  wrap(async (req, res) => {
    const { url } = parse(z.object({ url: z.string().url().max(2048) }), req.body);
    try {
      const id = await addFeed(req.household.id, url);
      await audit("calendar_added", { householdId: req.household.id, actorUserId: req.user.id, target: id });
      res.status(201).json({ id });
    } catch (err) {
      if (err instanceof BlockedRequestError) throw badRequest(err.message);
      throw badRequest(`Could not add that feed: ${err.message.slice(0, 120)}`);
    }
  })
);

router.post("/:householdId/calendars/:id/refresh",
  requireAuth, loadHousehold(), atLeast("adult"),
  limit("calendar-refresh", { capacity: 20, perSecond: 0.1, by: "household" }),
  wrap(async (req, res) => {
    const feeds = await listFeeds(req.household.id);
    if (!feeds.some((f) => f.id === req.params.id)) throw notFound();
    res.json(await refreshFeed(req.params.id));
  })
);

router.delete("/:householdId/calendars/:id",
  requireAuth, loadHousehold(), atLeast("adult"), requireWritable,
  wrap(async (req, res) => {
    if (!(await removeFeed(req.household.id, req.params.id))) throw notFound();
    await audit("calendar_removed", {
      householdId: req.household.id, actorUserId: req.user.id, target: req.params.id,
    });
    res.json({ ok: true });
  })
);

/** Expanded events for a window. Defaults to a sensible span around today. */
router.get("/:householdId/calendar-events", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const now = new Date();
  const start = req.query.start ? new Date(String(req.query.start)) : new Date(now - 30 * 86400e3);
  const end = req.query.end ? new Date(String(req.query.end)) : new Date(+now + 180 * 86400e3);
  if (Number.isNaN(+start) || Number.isNaN(+end)) throw badRequest("Invalid start or end date");
  if (end - start > 400 * 86400e3) throw badRequest("Window is too wide (max 400 days)");

  res.json(await eventsFor(req.household.id, start, end));
}));

export default router;
