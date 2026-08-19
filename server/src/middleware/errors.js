// errors.js — one error shape for the whole API.
//
// The rule that matters: a client learns what it needs to fix its own request
// and nothing else. Stack traces, SQL text, and file paths go to the server log;
// the response carries a code and a sentence.

export class ApiError extends Error {
  constructor(status, code, message, meta) {
    super(message);
    this.status = status;
    this.code = code;
    this.meta = meta;
  }
}

export const badRequest  = (m = "Invalid request", meta) => new ApiError(400, "bad_request", m, meta);
export const unauthorized = (m = "Sign in to continue")  => new ApiError(401, "unauthorized", m);
export const forbidden   = (m = "You do not have access to this") => new ApiError(403, "forbidden", m);
export const notFound    = (m = "Not found")             => new ApiError(404, "not_found", m);
export const conflict    = (m = "Conflict", meta)        => new ApiError(409, "conflict", m, meta);
export const tooLarge    = (m = "Too large")             => new ApiError(413, "too_large", m);
export const rateLimited = (retryAfter) =>
  new ApiError(429, "rate_limited", "Too many requests. Slow down.", { retryAfter });

/** Wrap an async handler so a rejected promise reaches the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFoundHandler(req, res) {
  res.status(404).json({ error: "Not found", code: "not_found" });
}

/**
 * Should this refusal be written down?
 *
 * Refusals used to be entirely silent: only 500s reached the log, so a request
 * turned away with a 403 or a 409 left no trace anywhere on the server. That is
 * fine until somebody reports "it won't let me do X" -- at which point there is
 * nothing to look at, and the only way to find out what happened is to guess.
 *
 * Everything a browser does routinely is excluded, so this stays quiet in
 * normal running:
 *   401  an unauthenticated poll before sign-in; constant and uninteresting
 *   404  missing assets and probing
 *   429  already visible in the rate-limit table
 * A refused *write* is nearly always either a real bug or a real attack, and
 * either way somebody should be able to see it.
 */
function worthLogging(status, method) {
  if (status === 401 || status === 404 || status === 429) return false;
  if (status >= 500) return true;
  return status >= 400 && !["GET", "HEAD", "OPTIONS"].includes(method);
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    if (err.meta?.retryAfter) res.set("Retry-After", String(err.meta.retryAfter));
    if (worthLogging(err.status, req.method)) {
      // Path and ids only. No bodies, no headers, no query string -- those carry
      // display tokens and invitation tokens, and a log is not a place for a
      // credential.
      console.warn(
        `[refused] ${req.method} ${req.path} -> ${err.status} ${err.code}` +
        `${req.user?.id ? ` actor=${String(req.user.id).slice(0, 8)}` : ""}` +
        ` :: ${err.message}`
      );
    }
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.meta || {}) });
  }

  // Body parser rejections arrive as plain errors with a status attached.
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large", code: "too_large" });
  }
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "Malformed JSON", code: "bad_json" });
  }

  // Postgres constraint violations. Mapped rather than surfaced: the raw
  // message names tables and columns, which is free schema reconnaissance.
  if (err?.code === "23505") {
    return res.status(409).json({ error: "That already exists", code: "duplicate" });
  }
  if (err?.code === "23503" || err?.code === "23514") {
    return res.status(400).json({ error: "Invalid request", code: "bad_request" });
  }

  const ref = Math.random().toString(36).slice(2, 10);
  console.error(`[error ${ref}] ${req.method} ${req.path}`, err);
  res.status(500).json({ error: "Something went wrong on our end", code: "internal", ref });
}
