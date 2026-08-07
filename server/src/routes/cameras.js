// cameras.js — the household's own CamWatch, proxied.
//
// Everything here is a pass-through to a system the household runs themselves.
// HouseHub adds three things CamWatch cannot do on its own:
//
//   1. Its own access control. CamWatch has one shared password; here a viewer
//      sees cameras and an admin configures them, and a wall display can show
//      the back garden without ever holding that password.
//   2. Revocation that means something. Revoke a display and its cameras go with
//      it, because the display never had the credential in the first place.
//   3. Scope. A household picks which cameras appear, and whether faces and
//      recordings are surfaced at all.
//
// Nothing is stored. Streams and images are piped straight through, so a
// household's footage never lands on this server's disk even briefly.

import express from "express";
import { z } from "zod";
import { Readable } from "node:stream";

import { q } from "../db/pool.js";
import { wrap, badRequest, forbidden, notFound, ApiError } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import { requireAuth, loadHousehold, requireRole, requireWritable } from "../middleware/auth.js";
import * as cam from "../services/camwatch.js";
import { audit } from "../services/audit.js";

export const memberRouter = express.Router({ mergeParams: true });
export const displayRouter = express.Router();

const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest(r.error.issues[0].message);
  return r.data;
};

/** Pipe a CamWatch response straight to the client without buffering it. */
async function pipe(res, upstream) {
  res.status(upstream.status);
  const type = upstream.headers.get("content-type");
  if (type) res.set("Content-Type", type);
  // Snapshots and streams must never be cached by a proxy or a shared tablet.
  res.set("Cache-Control", "no-store, private");
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
}

/* ============================================================== setup ===== */

memberRouter.get("/", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const config = await cam.getConfig(req.household.id);
  if (!config) return res.json({ connected: false });

  res.json({
    connected: true,
    // The address is shown so a member can see which system is connected. The
    // password never is.
    url: config.url,
    cameras: config.cameras,
    showAlerts: config.showAlerts,
    showFaces: config.showFaces,
    showRecordings: config.showRecordings,
    lastOkAt: config.lastOkAt,
    lastError: config.lastError,
  });
}));

memberRouter.post("/test",
  requireAuth, loadHousehold(), requireRole("admin"),
  limit("cam-test", { capacity: 20, perSecond: 0.1, by: "household" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      url: z.string().url().max(500),
      password: z.string().min(1).max(400),
    }), req.body);

    try {
      await cam.assertReachableTarget(body.url);
      // Saves nothing: proves the credentials work before anything is stored.
      const probe = await fetch(`${body.url.replace(/\/+$/, "")}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: body.password }),
        signal: AbortSignal.timeout(10_000),
      });
      if (probe.status === 401) return res.json({ ok: false, error: "CamWatch rejected that password" });
      if (!probe.ok) return res.json({ ok: false, error: `CamWatch returned ${probe.status}` });
      res.json({ ok: true, message: "Connected" });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  })
);

memberRouter.put("/",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  limit("cam-configure", { capacity: 20, perSecond: 0.05, by: "household" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      url: z.string().url().max(500),
      password: z.string().min(1).max(400).optional(),
      cameras: z.array(z.string().max(40)).max(64).optional(),
      showAlerts: z.boolean().optional(),
      showFaces: z.boolean().optional(),
      showRecordings: z.boolean().optional(),
    }), req.body);

    try {
      await cam.saveConfig(req.household.id, body, req.user.id);
    } catch (err) {
      throw new ApiError(err.status || 400, "cam_failed", err.message);
    }

    await audit("cameras_configured", {
      householdId: req.household.id, actorUserId: req.user.id,
      meta: { cameras: body.cameras?.length ?? null, faces: body.showFaces ?? false },
    });
    res.json({ ok: true });
  })
);

memberRouter.delete("/",
  requireAuth, loadHousehold(), requireRole("admin"),
  wrap(async (req, res) => {
    await cam.removeConfig(req.household.id);
    await audit("cameras_disconnected", { householdId: req.household.id, actorUserId: req.user.id });
    res.json({
      ok: true,
      note: "The CamWatch password has been deleted from this server. Your footage, faces and " +
            "recordings were never stored here and are untouched on your own machine.",
    });
  })
);

/** Everything CamWatch knows about, for the picker. */
memberRouter.get("/available",
  requireAuth, loadHousehold(), requireRole("admin"),
  wrap(async (req, res) => {
    res.json(await cam.call(req.household.id, "/api/cameras"));
  })
);

/* ============================================================= viewing ==== */

memberRouter.get("/cameras", requireAuth, loadHousehold(), wrap(async (req, res) => {
  res.json(await cam.listCameras(req.household.id));
}));

memberRouter.get("/status", requireAuth, loadHousehold(), wrap(async (req, res) => {
  res.json(await cam.status(req.household.id));
}));

memberRouter.get("/snapshot/:cameraId.jpg",
  requireAuth, loadHousehold(),
  limit("cam-snapshot", { capacity: 300, perSecond: 3, by: "user" }),
  wrap(async (req, res) => {
    if (!(await cam.isAllowedCamera(req.household.id, req.params.cameraId))) {
      throw forbidden("That camera is not one this household has chosen to show");
    }
    await pipe(res, await cam.call(req.household.id, `/api/snapshot/${req.params.cameraId}`, { raw: true }));
  })
);

/**
 * The live MJPEG stream.
 *
 * Held open for as long as somebody is watching, so it takes the request's own
 * abort signal instead of a timeout, and the upstream connection is closed when
 * the viewer navigates away.
 */
memberRouter.get("/stream/:cameraId",
  requireAuth, loadHousehold(),
  limit("cam-stream", { capacity: 20, perSecond: 0.2, by: "user" }),
  wrap(async (req, res) => {
    if (!(await cam.isAllowedCamera(req.household.id, req.params.cameraId))) {
      throw forbidden("That camera is not one this household has chosen to show");
    }
    const ctl = new AbortController();
    req.on("close", () => ctl.abort());
    await pipe(res, await cam.call(req.household.id, `/api/stream/${req.params.cameraId}`,
      { raw: true, signal: ctl.signal }));
  })
);

memberRouter.get("/alerts", requireAuth, loadHousehold(), wrap(async (req, res) => {
  res.json(await cam.listAlerts(req.household.id, { limit: Number(req.query.limit) || 50 }));
}));

memberRouter.get("/alerts/:id/snapshot.jpg", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const config = await cam.getConfig(req.household.id);
  if (!config?.showAlerts) throw forbidden("Alerts are not enabled for this household");
  await pipe(res, await cam.call(req.household.id, `/api/alerts/${req.params.id}/snapshot`, { raw: true }));
}));

memberRouter.post("/alerts/:id/acknowledge",
  requireAuth, loadHousehold(), requireWritable,
  wrap(async (req, res) => {
    res.json(await cam.call(req.household.id, `/api/alerts/${req.params.id}/acknowledge`, { method: "POST" }));
  })
);

/**
 * Enrolled faces.
 *
 * Off by default and separately switchable, because this is biometric data --
 * special category under GDPR Article 9. It stays on the household's own
 * machine; HouseHub only ever shows it, and only when asked to.
 */
memberRouter.get("/faces", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const config = await cam.getConfig(req.household.id);
  if (!config?.showFaces) {
    throw forbidden("Face recognition is not surfaced in HouseHub for this household");
  }
  res.json(await cam.call(req.household.id, "/api/faces"));
}));

memberRouter.get("/recordings", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const config = await cam.getConfig(req.household.id);
  if (!config?.showRecordings) throw forbidden("Recordings are not surfaced in HouseHub");
  res.json(await cam.call(req.household.id, "/api/recordings"));
}));

/* ============================================================ displays ==== */

/**
 * A wall display's view: live cameras only.
 *
 * No alerts, no faces, no recordings, no configuration -- a screen in a hallway
 * showing a history of who came to the door, or a list of enrolled faces, is a
 * different and much worse thing than a screen showing the back garden right
 * now. The camera list is still the household's chosen subset.
 */
displayRouter.get("/cameras",
  limit("display-cam-list", { capacity: 60, perSecond: 0.5 }),
  wrap(async (req, res) => {
    if (!req.display.scopes.includes("home")) {
      throw forbidden("This display is not permitted to show cameras");
    }
    res.json(await cam.listCameras(req.display.household_id));
  })
);

displayRouter.get("/snapshot/:cameraId.jpg",
  limit("display-cam-snapshot", { capacity: 600, perSecond: 5 }),
  wrap(async (req, res) => {
    if (!req.display.scopes.includes("home")) throw forbidden("Not permitted on this display");
    if (!(await cam.isAllowedCamera(req.display.household_id, req.params.cameraId))) {
      throw forbidden("That camera is not one this household has chosen to show");
    }
    await pipe(res, await cam.call(req.display.household_id, `/api/snapshot/${req.params.cameraId}`, { raw: true }));
  })
);

displayRouter.get("/stream/:cameraId",
  limit("display-cam-stream", { capacity: 20, perSecond: 0.2 }),
  wrap(async (req, res) => {
    if (!req.display.scopes.includes("home")) throw forbidden("Not permitted on this display");
    if (!(await cam.isAllowedCamera(req.display.household_id, req.params.cameraId))) {
      throw forbidden("That camera is not one this household has chosen to show");
    }
    const ctl = new AbortController();
    req.on("close", () => ctl.abort());
    await pipe(res, await cam.call(req.display.household_id, `/api/stream/${req.params.cameraId}`,
      { raw: true, signal: ctl.signal }));
  })
);

export default { memberRouter, displayRouter };
