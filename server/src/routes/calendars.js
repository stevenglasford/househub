// calendars.js — subscribed feed management. Thin by design; the work is in
// services/calendars.js and services/safe-fetch.js.

import express from "express";
import { z } from "zod";

import { wrap, badRequest, notFound } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import { requireAuth, loadHousehold, atLeast, requireWritable } from "../middleware/auth.js";
import { addFeed, addFeedFromText, removeFeed, listFeeds, refreshFeed, eventsFor } from "../services/calendars.js";
import {
  connectAccount, listAccounts, removeAccount, setPushEnabled, pushToCalendar,
  ICLOUD_CALDAV, AuthError,
} from "../services/caldav-sync.js";
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
    // Either a subscription URL or the contents of a downloaded .ics file.
    const body = parse(z.object({
      url: z.string().url().max(2048).optional(),
      icsText: z.string().max(5_000_000).optional(),
    }).refine((v) => v.url || v.icsText, { message: "Give a calendar URL or an .ics file" }), req.body);

    try {
      const id = body.url
        ? await addFeed(req.household.id, body.url)
        : await addFeedFromText(req.household.id, body.icsText);
      await audit("calendar_added", {
        householdId: req.household.id, actorUserId: req.user.id, target: id,
        meta: { kind: body.url ? "url" : "file" },
      });
      // The id is what the client stores alongside its own name and colour for
      // this feed, inside the encrypted document.
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

/* ------------------------------------------------------- two-way sync --- */

/* CalDAV, for writing the household's own events back out to a real calendar.
   Admin-only throughout: connecting one stores a credential on the server, and
   enabling a push means this server can alter somebody's actual calendar. */

const AccountBody = z.object({
  serverUrl: z.string().url().max(300).optional(),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
});

router.get("/:householdId/caldav", requireAuth, loadHousehold(), atLeast("adult"), wrap(async (req, res) => {
  res.json({ accounts: await listAccounts(req.household.id), defaultServer: ICLOUD_CALDAV });
}));

router.post("/:householdId/caldav",
  requireAuth, loadHousehold(), atLeast("admin"), requireWritable,
  // Each attempt is an outbound request with a credential on it. Slow on
  // purpose: this is also the endpoint somebody would use to test a stolen
  // password list against iCloud.
  limit("caldav-connect", { capacity: 5, perSecond: 0.02, by: "household" }),
  wrap(async (req, res) => {
    const body = parse(AccountBody, req.body);
    try {
      const out = await connectAccount(req.household.id, body);
      await audit(req, "caldav.connect", { calendars: out.calendars });
      res.json({ ok: true, ...out, accounts: await listAccounts(req.household.id) });
    } catch (err) {
      if (err instanceof AuthError) throw badRequest(err.message);
      if (err instanceof BlockedRequestError) throw badRequest(err.message);
      throw badRequest(err.message || "Could not reach that CalDAV server.");
    }
  }));

router.delete("/:householdId/caldav/:accountId",
  requireAuth, loadHousehold(), atLeast("admin"), requireWritable,
  wrap(async (req, res) => {
    await removeAccount(req.household.id, req.params.accountId);
    await audit(req, "caldav.disconnect", {});
    res.json({ ok: true, accounts: await listAccounts(req.household.id) });
  }));

router.put("/:householdId/caldav/calendars/:calendarId",
  requireAuth, loadHousehold(), atLeast("admin"), requireWritable,
  wrap(async (req, res) => {
    const { pushEnabled } = parse(z.object({ pushEnabled: z.boolean() }), req.body);
    try {
      await setPushEnabled(req.household.id, req.params.calendarId, pushEnabled);
    } catch (err) { throw badRequest(err.message); }
    await audit(req, pushEnabled ? "caldav.push.enable" : "caldav.push.disable", {});
    res.json({ ok: true, accounts: await listAccounts(req.household.id) });
  }));

/* The complete set of events that should be on this calendar.
   Sent by the client because they live in the encrypted document and the server
   cannot read it -- which is also why this cannot run on a timer. */
const PushBody = z.object({
  events: z.array(z.object({
    id: z.string().min(1).max(100),
    title: z.string().max(500).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^\d{2}:\d{2}$/).optional().or(z.literal("")),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).optional().or(z.literal("")),
    allDay: z.boolean().optional(),
    notes: z.string().max(2000).optional(),
    location: z.string().max(500).optional(),
  })).max(1000),
});

router.post("/:householdId/caldav/calendars/:calendarId/push",
  requireAuth, loadHousehold(), atLeast("adult"), requireWritable,
  limit("caldav-push", { capacity: 20, perSecond: 0.1, by: "household" }),
  wrap(async (req, res) => {
    const { events } = parse(PushBody, req.body);
    try {
      res.json(await pushToCalendar(req.household.id, req.params.calendarId, events));
    } catch (err) { throw badRequest(err.message); }
  }));

export default router;
