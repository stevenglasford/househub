// integrations.js — what a household can plug in, and what it has.
//
// One endpoint, deliberately. The settings page asks "what is available and what
// is connected", and each integration's own routes handle the rest. Adding an
// integration means adding a manifest, not touching this file.

import express from "express";

import { wrap } from "../middleware/errors.js";
import { requireAuth, loadHousehold } from "../middleware/auth.js";
import { listForHousehold } from "../integrations/registry.js";

export const router = express.Router({ mergeParams: true });

router.get("/", requireAuth, loadHousehold(), wrap(async (req, res) => {
  res.json({
    // Stated in the API as well as the docs: an integration reaches somebody
    // else's system on the household's behalf. It is not a route into the vault.
    about:
      "Integrations connect your household to a separate system you run yourself. " +
      "They never touch your household's encrypted contents.",
    integrations: await listForHousehold(req.household.id),
  });
}));

export default router;
