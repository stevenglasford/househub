// checkin.js — the nightly conversation question, generated rather than rotated.
//
// The original app cycled a fixed array of about forty questions by day of
// year. That is fine for a few weeks and then you can predict it, and a check-in
// you can predict is one people start skipping. This asks the local model for
// one instead, conditioned on how the day actually went.
//
// THE PRIVACY DECISION IS THE HOUSEHOLD'S. Building the context is the only
// moment when anything decrypted leaves the browser, so it happens here, in one
// function, with the level chosen by a setting rather than by a developer:
//
//   minimal   nothing about this household at all
//   signals   counts only -- "2 overdue tasks, 1 thing to discuss"  (default)
//   full      actual titles
//
// Even 'full' goes only to Ollama on the household's own server. But 'signals'
// is enough to make the question feel observant, so it is what ships on.

import * as session from "./session.js";

export const PRIVACY_LEVELS = ["minimal", "signals", "full"];

const parseYMD = (s) => {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
};

const seasonOf = (date) => {
  const m = date.getMonth();
  return m <= 1 || m === 11 ? "winter" : m <= 4 ? "spring" : m <= 7 ? "summer" : "autumn";
};

/**
 * Turn the decrypted document into the smallest useful description of today.
 *
 * Everything here is derived, never copied: counts, booleans, and a mood band.
 * At 'signals' no title, name, note or date from the household is included.
 */
export function buildContext(doc, dateKey, { privacy = "signals", tone = "warm" } = {}) {
  const people = Array.isArray(doc.people) ? doc.people : [];
  const base = {
    householdSize: Math.max(1, people.length || 2),
    tone,
  };

  if (privacy === "minimal") return base;

  const today = parseYMD(dateKey);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const tomorrow = iso(new Date(+today + 86400e3));

  // Overdue: dated tasks before today that were never ticked.
  const overdue = (doc.tasks || []).filter(
    (t) => t?.date && t.date < dateKey && !t.done
  ).length;

  const agendaOpen = (doc.agenda || []).filter((a) => a && !a.resolved).length;

  const slipped = (doc.projects || []).filter(
    (p) => p && !p.doneOn && Array.isArray(p.dates) && p.dates.some((d) => d < dateKey) && (p.percent ?? 0) < 100
  ).length;

  const meals = doc.meals?.[tomorrow];
  const mealsUnplanned = !meals || !["breakfast", "lunch", "dinner"].some(
    (slot) => Array.isArray(meals[slot]) && meals[slot].length
  );

  const busyTomorrow = (doc.events || []).filter((e) => e?.date === tomorrow).length >= 3;

  // Mood: the average of recent self-reported check-ins, banded so the model
  // gets a direction without receiving anybody's actual numbers.
  const recent = Object.entries(doc.status || {})
    .filter(([d]) => d <= dateKey)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 5)
    .flatMap(([, byPerson]) => Object.values(byPerson || {}))
    .map((s) => Number(s?.happiness))
    .filter(Number.isFinite);

  const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
  const mood = avg == null ? undefined : avg >= 4 ? "good" : avg >= 2.5 ? "mixed" : "low";

  const ctx = {
    ...base,
    hasDependents: people.length > 2,
    mood,
    signals: { overdueCount: overdue, agendaCount: agendaOpen, projectsSlipped: slipped, mealsUnplanned, busyTomorrow },
    // The model's own previous questions, so it does not repeat itself. Not
    // household content.
    recentTopics: Object.values(doc.checkin?.generated || {}).slice(-8).map((g) => g?.question).filter(Boolean),
    season: seasonOf(today),
  };

  if (privacy === "full") {
    ctx.agendaTitles = (doc.agenda || []).filter((a) => !a?.resolved).slice(0, 5).map((a) => a.text);
  }

  return ctx;
}

/**
 * The question for a given day.
 *
 * Cached inside the household document, keyed by date, for three reasons: every
 * device shows the same question, a re-render does not re-generate, and a
 * household that loses Ollama for an evening still has tonight's question.
 *
 * Returns { question, source } where source is 'cache' | 'ai' | 'fallback'.
 */
export async function questionForDate(doc, dateKey, { onCache } = {}) {
  const settings = doc.checkin || {};
  const cached = settings.generated?.[dateKey];
  if (cached?.question) return { question: cached.question, source: "cache" };

  if (settings.aiEnabled === false) {
    return { question: null, source: "disabled" };
  }

  try {
    const context = buildContext(doc, dateKey, {
      privacy: settings.aiPrivacy || "signals",
      tone: settings.tone || "warm",
    });
    const res = await session.generate("checkin_question", context, {
      // The household's own steer, from the encrypted document.
      instructions: settings.instructions || undefined,
      // A check-in question can land on a wall display, so the model is told to
      // keep it suitable for a screen other people can see unless the household
      // has said this hub is private.
      audience: settings.audience || "shared",
    });
    if (!res?.question) throw new Error("empty");

    // The server returns a fallback question with fallback:true when Ollama is
    // down. Show it, but do not cache it -- tomorrow deserves another attempt.
    if (!res.fallback && onCache) {
      onCache(dateKey, { question: res.question, model: res.model, at: Date.now() });
    }
    return { question: res.question, source: res.fallback ? "fallback" : "ai" };
  } catch {
    // Never let a missing model break the evening. The caller falls back to the
    // built-in rotation, which is exactly what the app did before.
    return { question: null, source: "fallback" };
  }
}

/** Pre-generate a batch, so a household with flaky AI is never caught short. */
export async function refillBank(doc, count = 10) {
  const context = buildContext(doc, new Date().toISOString().slice(0, 10), {
    privacy: doc.checkin?.aiPrivacy || "signals",
  });
  const res = await session.generate("checkin_batch", { ...context, count }, {
    instructions: doc.checkin?.instructions || undefined,
    audience: doc.checkin?.audience || "shared",
  });
  return res?.questions || [];
}

/**
 * A date-night idea, steered by the household's own instructions.
 *
 * This is the other place where "platonic flatmates" and "partners exploring
 * intimacy" want genuinely different output from the same button, and where the
 * app has no business guessing which.
 */
export async function suggestDateIdea(doc, { jar, existing } = {}) {
  const season = ["winter", "winter", "spring", "spring", "spring", "summer",
                  "summer", "summer", "autumn", "autumn", "autumn", "winter"][new Date().getMonth()];
  const res = await session.generate("date_idea", {
    jar: jar || "any",
    season,
    existing: (existing || []).slice(0, 10),
    householdSize: (doc.people || []).length || 2,
  }, {
    instructions: doc.dateIdeaInstructions || doc.checkin?.instructions || undefined,
    // Drawn deliberately by a person, so it is not held to display standards.
    audience: "private",
  });
  return res?.idea || null;
}

/**
 * The list of things tonight's walkthrough will go through.
 *
 * Worked out ONCE, when the walkthrough opens, and then held still. It used to
 * be recomputed on every render with each step included only while it was still
 * outstanding, which had two consequences, both reported as the check-in being
 * broken:
 *
 *   * The status step disappeared as soon as everybody had recorded something.
 *     With two people that meant the second person moving their first slider
 *     deleted the step out from under themselves, before they had set the other
 *     two. They could not finish.
 *   * Every other step did the same, so the list shortened underneath you and
 *     the walkthrough jumped to whatever now occupied that index.
 *
 * A walkthrough is a fixed list. Deciding what is on it belongs at the start;
 * after that, doing something must not change what you are being asked.
 */
export function buildCheckinSteps({
  hasPrompt = false,
  overdueCount = 0,
  slippedCount = 0,
  topicsCount = 0,
  tomorrowCount = 0,
  mealsPlanned = true,
  peopleCount = 0,
} = {}) {
  const steps = [];
  if (hasPrompt) steps.push({ id: "prompt", label: "Tonight's question" });
  if (overdueCount) steps.push({ id: "overdue", label: "Overdue", count: overdueCount });
  if (slippedCount) steps.push({ id: "slipped", label: "Projects that slipped", count: slippedCount });
  if (topicsCount) steps.push({ id: "topics", label: "Things to talk about", count: topicsCount });
  if (tomorrowCount) steps.push({ id: "tomorrow", label: "Tomorrow", count: tomorrowCount });
  if (!mealsPlanned) steps.push({ id: "meals", label: "Tomorrow's meals" });
  // Offered whenever there is anybody to ask, and never withdrawn part-way:
  // somebody who already recorded a score may want to change it, and the other
  // person has not been asked yet.
  if (peopleCount) steps.push({ id: "status", label: "How we're doing" });
  steps.push({ id: "time", label: "Tomorrow's check-in" });
  return steps;
}
