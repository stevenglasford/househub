// ollama.js — the only inference path in this codebase, and it points at
// localhost.
//
// There is no provider abstraction here on purpose. An interface with an
// `OpenAIProvider` slot next to the Ollama one is an invitation for someone --
// a contributor, a future maintainer, an AI-authored pull request -- to set an
// API key and quietly start shipping households' private context to a third
// party. The constraint is enforced structurally instead: this module talks to
// one host, and `assertLocal` refuses to start if that host is not local.

import { OLLAMA_URL, OLLAMA_MODEL, OLLAMA_TIMEOUT_MS, OLLAMA_KEEP_ALIVE } from "../config.js";

/**
 * Refuse a remote Ollama.
 *
 * Someone will eventually point OLLAMA_URL at a GPU box "just for now". That is
 * a legitimate thing to want and a genuinely different privacy posture, so it
 * has to be opted into loudly (OLLAMA_ALLOW_REMOTE=1) rather than happening by
 * accident through a config file.
 */
function assertLocal(url) {
  if (process.env.OLLAMA_ALLOW_REMOTE === "1") return;
  const host = new URL(url).hostname;
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" ||
    host.endsWith(".local") ||
    // Docker's gateway back to the host, for the common case of a containerised
    // app talking to an Ollama the operator already runs natively.
    host === "host.docker.internal" ||
    host === "gateway.docker.internal" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    // A docker-compose service name, which resolves only on the compose network.
    /^[a-z0-9_-]+$/i.test(host);

  if (!isLocal) {
    throw new Error(
      `OLLAMA_URL points at ${host}, which is not local. Household context would leave this machine.\n` +
      "If that is genuinely what you want, set OLLAMA_ALLOW_REMOTE=1 and tell your users."
    );
  }
}
assertLocal(OLLAMA_URL);

export class OllamaError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

async function call(path, body, { timeoutMs = OLLAMA_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 404 && /model/i.test(detail)) {
        throw new OllamaError(
          `The model "${body.model}" is not installed. Run: ollama pull ${body.model}`,
          { status: 503 }
        );
      }
      throw new OllamaError(`Ollama returned ${res.status}`, { status: 502, retryable: res.status >= 500 });
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new OllamaError(
        `Generation timed out after ${Math.round(timeoutMs / 1000)}s. A larger model on a slow machine ` +
        "may need OLLAMA_TIMEOUT_MS raised.",
        { status: 504, retryable: true }
      );
    }
    if (err instanceof OllamaError) throw err;
    throw new OllamaError(
      `Could not reach Ollama at ${OLLAMA_URL}. Is it running? (ollama serve)`,
      { status: 503, retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function isAvailable() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

export async function listModels() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => ({ name: m.name, size: m.size, family: m.details?.family }));
  } catch { return []; }
}

/**
 * One-shot generation.
 *
 * `format: "json"` puts Ollama into constrained decoding, which is far more
 * reliable than asking a 7B model nicely to emit valid JSON and then repairing
 * what comes back.
 *
 * Nothing here is logged. Not the prompt, not the completion, not on error --
 * the prompt contains exactly the household detail the rest of this system goes
 * to considerable lengths to keep out of the server's reach, and an exception
 * handler that dumps `body` would undo all of it.
 */
export async function generate({ system, prompt, model = OLLAMA_MODEL, json = false, temperature = 0.8, maxTokens = 400 }) {
  const data = await call("/api/chat", {
    model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
    stream: false,
    ...(json ? { format: "json" } : {}),
    keep_alive: OLLAMA_KEEP_ALIVE,
    // `think` is a top-level field, not an option. Reasoning models otherwise
    // spend most of the token budget deliberating about a one-line question and
    // time out before they answer it.
    ...(/qwen3|deepseek-r1|magistral/i.test(model) ? { think: false } : {}),
    options: { temperature, num_predict: maxTokens },
  });

  let content = data?.message?.content ?? "";
  // Strip reasoning blocks from models that emit them regardless.
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return { content, model: data?.model || model, evalCount: data?.eval_count };
}

/** Generate and parse JSON, with one retry before giving up. */
export async function generateJSON(opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content, model } = await generate({ ...opts, json: true });
    try {
      // Small models sometimes wrap JSON in a fenced block despite format:json.
      const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      return { data: JSON.parse(cleaned), model };
    } catch {
      if (attempt === 1) {
        throw new OllamaError("The model did not return usable JSON after two attempts.", { status: 502 });
      }
    }
  }
}

/**
 * Load the model without generating anything, so the first real request of the
 * evening does not pay the 15-30s cold-start. Called at boot and periodically by
 * jobs/maintenance.js.
 */
export async function warm(model = OLLAMA_MODEL) {
  try {
    await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // An empty message list loads the model and returns immediately.
      body: JSON.stringify({ model, messages: [], keep_alive: OLLAMA_KEEP_ALIVE }),
      signal: AbortSignal.timeout(180_000),
    });
    return true;
  } catch {
    // A cold or absent Ollama is not an error worth surfacing at boot -- the
    // generate path reports it properly when someone actually asks for a question.
    return false;
  }
}
