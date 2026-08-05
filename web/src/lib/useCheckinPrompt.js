// useCheckinPrompt.js — the React side of the generated check-in question.
//
// Kept apart from checkin.js so that the context-building logic (the part that
// decides what leaves the browser) stays testable without a renderer.
//
// Behaviour, in order of preference:
//   1. a question already generated and cached for this date
//   2. a fresh one from the local model
//   3. the built-in rotation the app has always had
//
// Step 3 matters more than it looks. Ollama will be down sometimes -- the box
// rebooted, the model is being pulled, something else is using the GPU -- and a
// wall display that says "AI unavailable" instead of asking a question has
// simply broken the feature.

import { useState, useEffect, useCallback, useRef } from "react";
import { questionForDate } from "./checkin.js";

export function useCheckinPrompt(dateKey, doc, update, fallbackQuestion) {
  const cached = doc?.checkin?.generated?.[dateKey]?.question || null;
  const [state, setState] = useState(() =>
    cached ? { question: cached, source: "cache" } : { question: null, source: "loading" }
  );
  // One generation attempt per date per mount. Without this, every re-render
  // while the request is in flight queues another one.
  const attempted = useRef(new Set());

  const cache = useCallback((key, entry) => {
    update((d) => {
      d.checkin = { ...(d.checkin || {}) };
      d.checkin.generated = { ...(d.checkin.generated || {}), [key]: entry };
      // Keep a fortnight. This lives inside the encrypted document, and an
      // unbounded map of every question ever asked would grow the vault for no
      // benefit -- the model only needs the recent ones to avoid repeating.
      const keys = Object.keys(d.checkin.generated).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - 14))) delete d.checkin.generated[k];
      return d;
    });
  }, [update]);

  const run = useCallback(async (force = false) => {
    if (!dateKey || !doc) return;
    if (!force && attempted.current.has(dateKey)) return;
    attempted.current.add(dateKey);

    if (force) setState({ question: null, source: "loading" });
    const result = await questionForDate(
      force ? stripCache(doc, dateKey) : doc,
      dateKey,
      { onCache: cache }
    );

    setState(result.question
      ? result
      : { question: fallbackQuestion, source: result.source === "disabled" ? "builtin" : "fallback" });
  }, [dateKey, doc, cache, fallbackQuestion]);

  useEffect(() => {
    if (cached) { setState({ question: cached, source: "cache" }); return; }
    run();
  }, [dateKey, cached, run]);

  return {
    question: state.question || fallbackQuestion,
    // 'ai' | 'cache' | 'fallback' | 'builtin' | 'loading' -- the UI shows a
    // quiet marker for anything that is not the model's own answer, so nobody
    // wonders why tonight's question feels generic.
    source: state.source,
    regenerate: () => run(true),
  };
}

/** A copy of the document with this date's cached question removed. */
function stripCache(doc, dateKey) {
  if (!doc?.checkin?.generated?.[dateKey]) return doc;
  const generated = { ...doc.checkin.generated };
  delete generated[dateKey];
  return { ...doc, checkin: { ...doc.checkin, generated } };
}
