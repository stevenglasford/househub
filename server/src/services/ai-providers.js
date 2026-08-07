// ai-providers.js — where inference actually happens.
//
// THIS FILE REVERSES AN EARLIER DECISION, on request, and the way it does so is
// the point.
//
// The original services/ollama.js refused a non-local host and had no provider
// abstraction at all, deliberately: a codebase with an `OpenAIProvider` slot
// next to the Ollama one is one config change away from shipping households'
// private context to a third party. That constraint was structural rather than
// a setting, which is what made it worth anything.
//
// The owner has asked to be able to plug in Claude, ChatGPT, or a remote Ollama.
// That is their call. What survives from the old design is everything that stops
// the choice being made silently or by the wrong person:
//
//   - the operator decides which providers exist; a household decides whether to
//     use one. An operator cannot route somebody else's family to OpenAI.
//   - a non-local provider needs explicit, recorded household consent, and the
//     consent is cleared whenever the provider changes.
//   - `isLocal` is computed here from the kind and the URL. A client cannot
//     assert it, so nothing can claim to be local and not be.
//   - every generation is audited with which provider handled it.
//   - local Ollama remains the default, and is the only one where "nothing
//     leaves this machine" is still true.
//
// Prompts and completions are never stored, whichever provider is used.

import { q } from "../db/pool.js";
import { seal, openText } from "../crypto/seal.js";
import { OLLAMA_URL, OLLAMA_MODEL, OLLAMA_TIMEOUT_MS, OLLAMA_KEEP_ALIVE } from "../config.js";

export class AIError extends Error {
  constructor(message, { status = 502, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/* ----------------------------------------------------------- locality ----- */

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|host\.docker\.internal|gateway\.docker\.internal|[a-z0-9_-]+)$/i;
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Is this provider on the household's own network?
 *
 * Computed, never taken from input. Everything user-facing keys its warning off
 * this, so a provider that could lie about it would make the warning worthless.
 */
export function computeIsLocal(kind, baseUrl) {
  if (kind !== "ollama") return false;          // hosted APIs are never local
  if (!baseUrl) return true;                    // the server's own Ollama
  try {
    const host = new URL(baseUrl).hostname;
    return LOCAL_HOST.test(host) || PRIVATE_IP.test(host) || host.endsWith(".local");
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------- provider io --- */

export async function listProviders({ includeSecrets = false } = {}) {
  const { rows } = await q(
    `SELECT id, label, kind, base_url_enc, api_key_enc, default_model, is_local, enabled, created_at
       FROM ai_providers ORDER BY is_local DESC, label`
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    kind: r.kind,
    defaultModel: r.default_model,
    isLocal: r.is_local,
    enabled: r.enabled,
    createdAt: r.created_at,
    hasKey: Boolean(r.api_key_enc),
    baseUrl: r.base_url_enc ? safeOpen("aiBaseUrl", r.base_url_enc, r.id) : null,
    // Never leaves this module unless a caller is actually about to make a call.
    ...(includeSecrets
      ? { apiKey: r.api_key_enc ? safeOpen("aiApiKey", r.api_key_enc, r.id) : null }
      : {}),
  }));
}

function safeOpen(label, value, aad) {
  try { return openText(label, value, aad); } catch { return null; }
}

export async function getProvider(id) {
  const { rows } = await q("SELECT * FROM ai_providers WHERE id = $1 AND enabled", [id]);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id, label: r.label, kind: r.kind, isLocal: r.is_local,
    defaultModel: r.default_model,
    baseUrl: r.base_url_enc ? safeOpen("aiBaseUrl", r.base_url_enc, r.id) : null,
    apiKey: r.api_key_enc ? safeOpen("aiApiKey", r.api_key_enc, r.id) : null,
  };
}

export async function upsertProvider(patch, actorId) {
  const isLocal = computeIsLocal(patch.kind, patch.baseUrl);

  if (patch.id) {
    const { rows } = await q(
      `UPDATE ai_providers SET
         label = COALESCE($2, label),
         kind = COALESCE($3, kind),
         base_url_enc = CASE WHEN $4::boolean THEN $5 ELSE base_url_enc END,
         api_key_enc  = CASE WHEN $6::boolean THEN $7 ELSE api_key_enc END,
         default_model = COALESCE($8, default_model),
         is_local = $9, enabled = COALESCE($10, enabled), updated_at = now()
       WHERE id = $1 RETURNING id`,
      [patch.id, patch.label ?? null, patch.kind ?? null,
       patch.baseUrl !== undefined, patch.baseUrl ? seal("aiBaseUrl", patch.baseUrl, patch.id) : null,
       Boolean(patch.apiKey), patch.apiKey ? seal("aiApiKey", patch.apiKey, patch.id) : null,
       patch.defaultModel ?? null, isLocal, patch.enabled ?? null]
    );
    return rows[0]?.id;
  }

  // Two steps because the row id is the AAD its own secrets are sealed under --
  // which is what stops a provider's API key being copied into another row.
  const { rows } = await q(
    `INSERT INTO ai_providers (label, kind, default_model, is_local, enabled, created_by)
     VALUES ($1,$2,$3,$4,TRUE,$5) RETURNING id`,
    [patch.label, patch.kind, patch.defaultModel ?? null, isLocal, actorId]
  );
  const id = rows[0].id;
  await q(
    "UPDATE ai_providers SET base_url_enc = $2, api_key_enc = $3 WHERE id = $1",
    [id,
     patch.baseUrl ? seal("aiBaseUrl", patch.baseUrl, id) : null,
     patch.apiKey ? seal("aiApiKey", patch.apiKey, id) : null]
  );
  return id;
}

/* ------------------------------------------------- household selection ---- */

/**
 * Which provider a household uses, and whether it is allowed to.
 *
 * The consent check is here rather than at the edges so every caller inherits
 * it. A household that selected a hosted provider and then withdrew consent
 * falls back to local rather than quietly continuing to send data offsite.
 */
export async function providerForHousehold(householdId) {
  const { rows } = await q(
    `SELECT s.provider_id, s.model, s.offsite_consent_at,
            p.id, p.label, p.kind, p.is_local, p.default_model,
            p.base_url_enc, p.api_key_enc, p.enabled
       FROM household_ai_settings s
       LEFT JOIN ai_providers p ON p.id = s.provider_id
      WHERE s.household_id = $1`,
    [householdId]
  );
  const row = rows[0];

  const fallback = {
    id: null, label: "Local Ollama (on this server)", kind: "ollama",
    isLocal: true, baseUrl: OLLAMA_URL, apiKey: null,
    model: OLLAMA_MODEL, consented: true,
  };

  if (!row?.provider_id || !row.enabled) return fallback;
  if (!row.is_local && !row.offsite_consent_at) {
    // Selected but not consented: refuse to use it rather than silently
    // sending household context offsite.
    return { ...fallback, blocked: "consent_required", selectedLabel: row.label };
  }

  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    isLocal: row.is_local,
    baseUrl: row.base_url_enc ? safeOpen("aiBaseUrl", row.base_url_enc, row.id) : OLLAMA_URL,
    apiKey: row.api_key_enc ? safeOpen("aiApiKey", row.api_key_enc, row.id) : null,
    model: row.model || row.default_model || OLLAMA_MODEL,
    consented: true,
  };
}

export async function setHouseholdProvider(householdId, { providerId, model, consent }, actorId) {
  const provider = providerId ? await getProvider(providerId) : null;
  if (providerId && !provider) throw new AIError("No such provider", { status: 400 });

  // Consent is per provider. Switching clears it, so agreeing to one hosted
  // provider is not agreement to the next one somebody selects.
  const consentAt = provider && !provider.isLocal && consent ? new Date() : null;

  await q(
    `INSERT INTO household_ai_settings (household_id, provider_id, model, offsite_consent_at, offsite_consent_by, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (household_id) DO UPDATE SET
       provider_id = EXCLUDED.provider_id,
       model = EXCLUDED.model,
       offsite_consent_at = EXCLUDED.offsite_consent_at,
       offsite_consent_by = EXCLUDED.offsite_consent_by,
       updated_at = now()`,
    [householdId, providerId || null, model || null, consentAt, consentAt ? actorId : null]
  );
  return { providerId, isLocal: provider ? provider.isLocal : true, consented: Boolean(consentAt) };
}

/* -------------------------------------------------------------- calling --- */

const timeout = (ms) => AbortSignal.timeout(ms);

async function callOllama(provider, { system, prompt, json, temperature, maxTokens }) {
  const url = `${(provider.baseUrl || OLLAMA_URL).replace(/\/+$/, "")}/api/chat`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
      stream: false,
      ...(json ? { format: "json" } : {}),
      keep_alive: OLLAMA_KEEP_ALIVE,
      ...(/qwen3|deepseek-r1|magistral/i.test(provider.model) ? { think: false } : {}),
      options: { temperature, num_predict: maxTokens },
    }),
    signal: timeout(OLLAMA_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 404 && /model/i.test(detail)) {
      throw new AIError(`The model "${provider.model}" is not installed. Run: ollama pull ${provider.model}`, { status: 503 });
    }
    throw new AIError(`Ollama returned ${res.status}`, { retryable: res.status >= 500 });
  }
  const data = await res.json();
  return (data?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function callOpenAI(provider, { system, prompt, json, temperature, maxTokens }) {
  const base = (provider.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
      temperature,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: timeout(60_000),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new AIError(detail?.error?.message || `Provider returned ${res.status}`, { status: res.status === 401 ? 400 : 502 });
  }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content ?? "").trim();
}

async function callAnthropic(provider, { system, prompt, json, temperature, maxTokens }) {
  const base = (provider.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: maxTokens || 512,
      temperature,
      ...(system ? { system } : {}),
      messages: [{
        role: "user",
        // Claude has no JSON mode; asking plainly and parsing is the documented
        // approach, and generateJSON below retries once if it comes back prosy.
        content: json ? `${prompt}\n\nReply with JSON only, no prose and no code fences.` : prompt,
      }],
    }),
    signal: timeout(60_000),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new AIError(detail?.error?.message || `Claude returned ${res.status}`, { status: res.status === 401 ? 400 : 502 });
  }
  const data = await res.json();
  return (data?.content?.[0]?.text ?? "").trim();
}

const CALLERS = { ollama: callOllama, openai: callOpenAI, anthropic: callAnthropic };

/** One generation, against whichever provider this household selected. */
export async function generate(provider, opts) {
  const caller = CALLERS[provider.kind];
  if (!caller) throw new AIError(`Unsupported provider: ${provider.kind}`, { status: 400 });

  try {
    const content = await caller(provider, {
      temperature: 0.85, maxTokens: 400, ...opts,
    });
    // Nothing about the prompt or the completion is logged, on any path,
    // whichever provider handled it.
    return { content, model: provider.model, provider: provider.label, isLocal: provider.isLocal };
  } catch (err) {
    if (err instanceof AIError) throw err;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new AIError("The model did not respond in time", { status: 504, retryable: true });
    }
    throw new AIError(
      provider.isLocal
        ? `Could not reach the model at ${provider.baseUrl || OLLAMA_URL}. Is it running?`
        : `Could not reach ${provider.label}.`,
      { status: 503, retryable: true }
    );
  }
}

export async function generateJSON(provider, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await generate(provider, { ...opts, json: true });
    try {
      const cleaned = out.content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      return { ...out, data: JSON.parse(cleaned) };
    } catch {
      if (attempt === 1) throw new AIError("The model did not return usable JSON after two attempts.");
    }
  }
}

/** Models a provider offers, for the picker. */
export async function listModels(provider) {
  try {
    if (provider.kind === "ollama") {
      const res = await fetch(`${(provider.baseUrl || OLLAMA_URL).replace(/\/+$/, "")}/api/tags`,
        { signal: timeout(5000) });
      if (!res.ok) return [];
      return ((await res.json()).models || []).map((m) => m.name);
    }
    if (provider.kind === "openai") {
      const base = (provider.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${provider.apiKey}` }, signal: timeout(8000),
      });
      if (!res.ok) return [];
      return ((await res.json()).data || []).map((m) => m.id).sort();
    }
    if (provider.kind === "anthropic") {
      const res = await fetch(`${(provider.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/models`, {
        headers: { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" },
        signal: timeout(8000),
      });
      if (!res.ok) return [];
      return ((await res.json()).data || []).map((m) => m.id);
    }
  } catch { /* a provider that cannot be listed can still be typed in by hand */ }
  return [];
}
