// ai.js — the local inference endpoint.
//
// What this route does and does not do is worth stating plainly, because it is
// the one place where household plaintext exists on the server at all:
//
//   - The client decrypts the household document, extracts the few signals it
//     wants to condition on, and posts those. Plaintext lives in this process's
//     memory for the duration of one request and is never written down: not to
//     the database, not to a log, not to an error report.
//   - There is no free-form prompt parameter. Callers choose a `kind` from a
//     fixed list and supply structured fields (services/checkin.js assembles the
//     actual prompt), so this cannot be used as a general-purpose LLM proxy and
//     a malicious client cannot rewrite the system prompt.
//   - Inference is local BY DEFAULT. A household may now select a hosted
//     provider instead (Claude, ChatGPT, a remote Ollama), and if it does, the
//     context for each request leaves this machine. That choice belongs to the
//     household, not the operator: offering a provider does not route anybody to
//     it, and using a non-local one requires consent recorded against a person
//     and a time. See services/ai-providers.js.
//
// The honest caveat, which docs/THREAT-MODEL.md repeats: an operator who
// modifies this file could log what passes through it. The protection against
// that is that the code is open, the AI feature is optional, and a household
// that does not trust its operator can set the privacy mode to `minimal` and
// send nothing but counts.

import express from "express";
import { z } from "zod";

import { wrap, badRequest, ApiError } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import { requireAuth, loadHousehold, requireRole, atLeast } from "../middleware/auth.js";
import { runGeneration, fallbackQuestion, KIND_NAMES } from "../services/checkin.js";
import {
  providerForHousehold, setHouseholdProvider, listProviders, listModels, AIError,
} from "../services/ai-providers.js";
import { audit } from "../services/audit.js";
import { AI_ENABLED, AI_RATE_PER_HOUR } from "../config.js";

export const router = express.Router();

/* ------------------------------------------------------------- schemas ----- */

// Every field a caller may send, spelled out. Anything else is dropped by zod
// before it can reach a prompt -- an allowlist, so adding a field is a
// deliberate act rather than something a client can do unilaterally.
export const contextSchema = z.object({
  householdSize: z.number().int().min(1).max(30).optional(),
  togetherYears: z.number().int().min(0).max(100).optional(),
  hasDependents: z.boolean().optional(),
  tone: z.enum(["warm", "playful", "practical", "reflective"]).optional(),
  mood: z.enum(["good", "mixed", "low"]).optional(),

  signals: z.object({
    overdueCount: z.number().int().min(0).max(999).optional(),
    agendaCount: z.number().int().min(0).max(999).optional(),
    projectsSlipped: z.number().int().min(0).max(999).optional(),
    mealsUnplanned: z.boolean().optional(),
    busyTomorrow: z.boolean().optional(),
  }).optional(),

  // Past questions, so the model does not repeat itself. These are its own
  // prior output rather than household content.
  recentTopics: z.array(z.string().max(200)).max(12).optional(),

  count: z.number().int().min(1).max(20).optional(),
  jar: z.string().max(40).optional(),
  /* What the household typed when asking for date ideas in their own words.
     Household content, so it is capped and goes to the local model only -- the
     same footing as `instructions`. Its absence here is what made the date-jar
     prompt fail with "Unsupported field: prompt": the schema is strict, so the
     request was refused at the route and never reached the model. */
  prompt: z.string().max(400).optional(),
  season: z.enum(["spring", "summer", "autumn", "winter"]).optional(),
  budget: z.enum(["free", "cheap", "moderate", "splurge"]).optional(),
  indoor: z.boolean().optional(),
  existing: z.array(z.string().max(200)).max(20).optional(),

  items: z.array(z.string().max(120)).max(50).optional(),
  aisles: z.array(z.string().max(40)).max(30).optional(),
}).strict();

export const generateSchema = z.object({
  kind: z.enum(KIND_NAMES),
  context: contextSchema.default({}),
  // The household's own steer, from their encrypted document. Capped, and
  // appended after the base rules rather than replacing them -- see
  // services/checkin.js.
  instructions: z.string().max(1200).optional(),
  // 'shared' when the result may land on a screen others can see, which tightens
  // what the model is asked for.
  audience: z.enum(["private", "shared"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
}).strict();

const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0];
    // 'unrecognized_keys' means a client tried to smuggle in a field we do not
    // accept. Name it, so a legitimate client bug is easy to find.
    throw badRequest(
      first.code === "unrecognized_keys"
        ? `Unsupported field: ${first.keys.join(", ")}`
        : first.message,
      { field: first.path.join(".") }
    );
  }
  return r.data;
};

/* -------------------------------------------------------------- status ----- */

router.get("/status", requireAuth, wrap(async (req, res) => {
  if (!AI_ENABLED) return res.json({ enabled: false, reason: "disabled_by_operator" });
  res.json({
    enabled: true,
    ratePerHour: AI_RATE_PER_HOUR,
    providers: (await listProviders()).filter((p) => p.enabled)
      .map(({ id, label, kind, isLocal, defaultModel }) => ({ id, label, kind, isLocal, defaultModel })),
  });
}));

/* ------------------------------------------------- per-household choice --- */

/**
 * Which provider this household uses.
 *
 * `isLocal` is computed on the server from the provider's kind and address, so
 * the warning a household sees cannot be wrong about whether their context
 * leaves the machine.
 */
router.get("/households/:householdId/provider",
  requireAuth, loadHousehold(),
  wrap(async (req, res) => {
    const p = await providerForHousehold(req.household.id);
    const models = await listModels(p).catch(() => []);
    res.json({
      providerId: p.id,
      label: p.label,
      kind: p.kind,
      isLocal: p.isLocal,
      model: p.model,
      models,
      blocked: p.blocked || null,
      selectedLabel: p.selectedLabel || null,
      available: (await listProviders()).filter((x) => x.enabled)
        .map(({ id, label, kind, isLocal, defaultModel }) => ({ id, label, kind, isLocal, defaultModel })),
      privacy: p.isLocal
        ? "Inference runs on hardware you control. Nothing leaves your network, and prompts are never stored."
        : `Context for each request is sent to ${p.label}. It is not stored by HouseHub, but it does leave this machine and is subject to that provider's terms.`,
    });
  })
);

router.put("/households/:householdId/provider",
  requireAuth, loadHousehold(), requireRole("admin"),
  wrap(async (req, res) => {
    const body = parse(z.object({
      providerId: z.string().uuid().nullable(),
      model: z.string().max(120).optional(),
      // Required for anything not local. Recorded with who agreed and when.
      consent: z.boolean().default(false),
    }).strict(), req.body);

    const out = await setHouseholdProvider(req.household.id, body, req.user.id);
    await audit("ai_provider_changed", {
      householdId: req.household.id, actorUserId: req.user.id,
      meta: { providerId: body.providerId, isLocal: out.isLocal, consented: out.consented },
    });
    res.json(out);
  })
);

/* ------------------------------------------------------------ generate ----- */

router.post("/households/:householdId/generate",
  requireAuth, loadHousehold(), atLeast("dependent"),
  // Per-household rather than per-user: a family shares one Ollama, and one
  // member holding a key down must not starve the others -- or the other
  // families on a shared server.
  limit("ai-generate", {
    capacity: AI_RATE_PER_HOUR,
    perSecond: AI_RATE_PER_HOUR / 3600,
    by: "household",
  }),
  wrap(async (req, res) => {
    if (!AI_ENABLED) throw new ApiError(503, "ai_disabled", "AI features are switched off on this server");

    const body = parse(generateSchema, req.body);

    const provider = await providerForHousehold(req.household.id);
    if (provider.blocked === "consent_required") {
      throw new ApiError(409, "consent_required",
        `This household selected ${provider.selectedLabel}, which is not on this server. ` +
        "An admin needs to confirm that context may leave the machine before it can be used.");
    }

    try {
      const result = await runGeneration(body.kind, body.context, {
        provider,
        instructions: body.instructions,
        audience: body.audience,
        temperature: body.temperature,
      });

      // Records that a generation happened and of what kind. Never the context,
      // never the output -- an audit trail of check-in questions would be a
      // slow-motion leak of exactly what the encryption protects.
      // Which provider handled it is recorded; the prompt and the answer are
      // not. A household should be able to see that something went offsite.
      await audit("ai_generated", {
        householdId: req.household.id, actorUserId: req.user.id,
        meta: { kind: body.kind, provider: result.provider, offsite: !result.isLocal },
      });

      res.json(result);
    } catch (err) {
      if (err instanceof AIError) {
        // A down model should degrade the feature, not break the evening. The
        // client shows the fallback and a quiet note.
        if (body.kind === "checkin_question") {
          return res.status(200).json({
            question: fallbackQuestion(),
            fallback: true,
            reason: err.message,
          });
        }
        throw new ApiError(err.status || 502, "ai_unavailable", err.message);
      }
      throw err;
    }
  })
);

export default router;
