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
//   - Inference is local. See services/ollama.js, which refuses a non-local host.
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
import { requireAuth, loadHousehold, atLeast } from "../middleware/auth.js";
import { runGeneration, fallbackQuestion, KIND_NAMES } from "../services/checkin.js";
import { isAvailable, listModels, OllamaError } from "../services/ollama.js";
import { audit } from "../services/audit.js";
import { AI_ENABLED, AI_RATE_PER_HOUR, OLLAMA_MODEL } from "../config.js";

export const router = express.Router();

/* ------------------------------------------------------------- schemas ----- */

// Every field a caller may send, spelled out. Anything else is dropped by zod
// before it can reach a prompt -- an allowlist, so adding a field is a
// deliberate act rather than something a client can do unilaterally.
const contextSchema = z.object({
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
  season: z.enum(["spring", "summer", "autumn", "winter"]).optional(),
  budget: z.enum(["free", "cheap", "moderate", "splurge"]).optional(),
  indoor: z.boolean().optional(),
  existing: z.array(z.string().max(200)).max(20).optional(),

  items: z.array(z.string().max(120)).max(50).optional(),
  aisles: z.array(z.string().max(40)).max(30).optional(),
}).strict();

const generateSchema = z.object({
  kind: z.enum(KIND_NAMES),
  context: contextSchema.default({}),
  model: z.string().max(120).optional(),
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
  const up = await isAvailable();
  res.json({
    enabled: true,
    available: up,
    defaultModel: OLLAMA_MODEL,
    models: up ? await listModels() : [],
    ratePerHour: AI_RATE_PER_HOUR,
    // Stated in the API, not just the docs, so a client can show it in the UI.
    privacy: "Inference runs on this server against a local model. Prompts and completions are never stored.",
  });
}));

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

    try {
      const result = await runGeneration(body.kind, body.context, {
        model: body.model,
        temperature: body.temperature,
      });

      // Records that a generation happened and of what kind. Never the context,
      // never the output -- an audit trail of check-in questions would be a
      // slow-motion leak of exactly what the encryption protects.
      await audit("ai_generated", {
        householdId: req.household.id, actorUserId: req.user.id, meta: { kind: body.kind },
      });

      res.json(result);
    } catch (err) {
      if (err instanceof OllamaError) {
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
