// timer-voice.js — turning "set a timer for ten minutes for the pasta" into a timer.
//
// Pure, and separate from the microphone, for two reasons. The obvious one is
// that a parser is testable and a microphone is not. The other is that the same
// parser has to serve the keyboard: a wall tablet in a kitchen is often being
// used by somebody whose hands are covered in flour, but it is just as often
// being used at arm's length by somebody who would rather type, and having two
// grammars for the one feature is how they drift apart.
//
// What speech recognition actually hands you is the thing to design around. It
// is not a command line. It arrives lowercase, unpunctuated, with numbers
// sometimes as digits and sometimes as words -- the same sentence can come back
// as "10 minutes" or "ten minutes" depending on nothing you control. It also
// mishears. So this parser is deliberately loose about the sentence around the
// numbers and strict about the numbers themselves, and everything it extracts
// is shown back to the household before a timer starts, because a timer that
// silently set itself to 50 minutes when you said 15 is worse than one that
// did not set at all.

const UNITS = {
  hour: 3600, hours: 3600, hr: 3600, hrs: 3600, h: 3600,
  minute: 60, minutes: 60, min: 60, mins: 60, m: 60,
  second: 1, seconds: 1, sec: 1, secs: 1, s: 1,
};

const WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  ninety: 90,
};

/* Phrases that mean a fraction of the unit that follows them. "Half an hour" is
   far and away the most common spoken duration in a kitchen and does not
   survive a number-then-unit grammar. */
const FRACTIONS = { half: 0.5, quarter: 0.25 };

/** Fold "twenty five" into 25 so the number grammar sees one token. */
function joinCompoundWords(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = WORDS[tokens[i]], b = WORDS[tokens[i + 1]];
    if (a !== undefined && b !== undefined && a >= 20 && a % 10 === 0 && b < 10) {
      out.push(String(a + b));
      i++;
    } else {
      out.push(tokens[i]);
    }
  }
  return out;
}

const numberOf = (tok) => {
  if (/^\d+$/.test(tok)) return Number(tok);
  return WORDS[tok] !== undefined ? WORDS[tok] : null;
};

/**
 * Split a phrase into tokens, with compound number words folded together.
 *
 * Kept as one pass shared by the duration scan and the label, because the two
 * used to disagree: the scan folded "twenty five" into 25 and the label did
 * not, so a stripped "five minutes" left "twenty" behind as the timer's name.
 */
function tokenize(text) {
  const raw = String(text || "").toLowerCase();
  return joinCompoundWords(raw.replace(/[^a-z0-9:]+/g, " ").trim().split(/\s+/).filter(Boolean));
}

/**
 * Scan tokens for durations, returning the total and which tokens were used.
 *
 * The consumed set is what lets the label be "everything else" rather than a
 * second grammar that has to stay in step with this one.
 */
function scanDuration(tokens) {
  let total = 0, found = false, lastUnit = null;
  const used = new Set();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (FRACTIONS[tok] !== undefined) {
      // "half an hour" — the unit follows.
      const at = tokens.slice(i + 1, i + 4).findIndex((t) => UNITS[t] !== undefined);
      if (at >= 0) {
        const j = i + 1 + at;
        total += FRACTIONS[tok] * UNITS[tokens[j]];
        found = true; lastUnit = UNITS[tokens[j]];
        for (let k = i; k <= j; k++) used.add(k);
        i = j;
        continue;
      }
      // "an hour and a half" — no unit after, so it means half of the last one
      // mentioned. Without this the half is silently dropped and the household
      // gets a 60 minute timer for a 90 minute instruction.
      if (lastUnit !== null) {
        total += FRACTIONS[tok] * lastUnit;
        found = true;
        used.add(i);
        if (tokens[i - 1] === "a" || tokens[i - 1] === "an") used.add(i - 1);
        if (tokens[i - 2] === "and") used.add(i - 2);
        if (tokens[i - 1] === "and") used.add(i - 1);
      }
      continue;
    }

    const n = numberOf(tok);
    if (n === null) continue;

    let unitAt = -1;
    for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
      if (UNITS[tokens[j]] !== undefined) { unitAt = j; break; }
      if (numberOf(tokens[j]) !== null) break; // another number: this one had no unit
    }
    if (unitAt >= 0) {
      total += n * UNITS[tokens[unitAt]];
      found = true; lastUnit = UNITS[tokens[unitAt]];
      for (let k = i; k <= unitAt; k++) used.add(k);
      i = unitAt;
    }
  }

  return { ms: found ? Math.round(total * 1000) : null, used };
}

/**
 * Every duration mentioned, summed.
 *
 * Summed rather than taking the first, because "an hour and a half" and "one
 * hour thirty minutes" are the same instruction and both arrive as two
 * quantities. Returns null when nothing timelike was said at all -- distinct
 * from zero, which would silently become a timer that has already finished.
 *
 * Also handles the bare "5:30", which is what you get when the recogniser
 * decides a spoken duration was a clock time.
 */
export function parseDuration(text) {
  const colon = String(text || "").toLowerCase().match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  if (colon) {
    const [, a, b, c] = colon;
    return c !== undefined
      ? (+a * 3600 + +b * 60 + +c) * 1000  // h:mm:ss
      : (+a * 60 + +b) * 1000;             // m:ss — a kitchen says "five thirty" meaning 5m30s
  }
  return scanDuration(tokenize(text)).ms;
}

/* Words that are scaffolding rather than a name. Stripped from the label so
   "set a timer for 10 minutes for the pasta" is called "pasta" and not
   "for the pasta". */
const LEAD = /^(?:hey\s+)?(?:hub|house|househub)?[,\s]*(?:can you\s+|please\s+)?(?:set|start|make|create|add|put)?\s*(?:me\s+)?(?:a|an|the)?\s*(?:new\s+)?/;
const TRAIL_TIMER = /\btimers?\b/g;

/**
 * "set a timer for 10 minutes for the pasta" -> { durationMs, label: "pasta" }
 *
 * The label is whatever is left once the command scaffolding and the duration
 * have been removed, which handles the several orderings people actually use
 * without needing a grammar for each:
 *
 *   "set a timer for the pasta for 10 minutes"
 *   "10 minute timer for the pasta"
 *   "pasta timer, 10 minutes"
 *
 * Returns null when there is no duration. A timer with a name and no length is
 * not a timer, and guessing one would be worse than asking.
 */
export function parseTimerCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const colon = raw.toLowerCase().match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  const tokens = tokenize(raw);
  let durationMs, used;
  if (colon) {
    durationMs = parseDuration(raw);
    used = new Set(tokens.map((t, i) => (/^\d+$/.test(t) || t.includes(":") ? i : -1)).filter((i) => i >= 0));
  } else {
    const scan = scanDuration(tokens);
    durationMs = scan.ms; used = scan.used;
  }
  if (durationMs === null || durationMs <= 0) return null;

  // The label is whatever the duration did not claim, less the scaffolding.
  // Doing it this way rather than with a second set of patterns is what keeps
  // the several orderings people actually use all working from one grammar:
  //   "set a timer for the pasta for 10 minutes"
  //   "10 minute timer for the pasta"
  //   "pasta timer, 10 minutes"
  const label = tokens
    .filter((_, i) => !used.has(i))
    .filter((t) => !STOPWORDS.has(t))
    .join(" ")
    .trim();

  return { durationMs, label: label ? recase(raw, label).slice(0, 60) : "" };
}

/* Command scaffolding — never part of what the timer is called. */
const STOPWORDS = new Set([
  "hey", "ok", "okay", "hub", "house", "househub", "can", "you", "please",
  "set", "start", "make", "create", "add", "put", "run", "give", "me",
  "a", "an", "the", "new", "another", "for", "of", "in", "on", "to", "and",
  "called", "named", "name", "it", "labelled", "labeled", "timer", "timers",
  "countdown", "my", "up", "going", "lasting", "that", "is", "s",
]);

/* Give the household back their own capitalisation where the original text
   still has it: "Pasta" reads better on a wall display than "pasta". */
function recase(raw, label) {
  const pattern = label.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const hit = raw.match(new RegExp(pattern, "i"));
  return hit ? hit[0].replace(/\s+/g, " ") : label;
}

/**
 * Whether a phrase is asking to stop something rather than start it, and what.
 *
 * "stop" on its own means the thing currently making noise, which is almost
 * always what somebody shouting at a kitchen display means.
 */
export function parseStopCommand(text) {
  const raw = String(text || "").toLowerCase().trim();
  if (!/\b(stop|cancel|dismiss|silence|quiet|off|clear)\b/.test(raw)) return null;
  const all = /\b(all|every|everything|them all)\b/.test(raw);
  const name = raw
    .replace(/\b(stop|cancel|dismiss|silence|quiet|off|clear|the|my|a|an|all|every|everything|please|timers?|hub|house)\b/g, " ")
    .replace(/[^a-z0-9'\s-]+/g, " ").replace(/\s+/g, " ").trim();
  return { all, name };
}

/** Which running timer a spoken name refers to. Loose, because speech is. */
export function matchTimerByName(timers, name) {
  const want = String(name || "").toLowerCase().trim();
  if (!want) return null;
  const list = timers || [];
  return list.find((t) => (t.label || "").toLowerCase() === want)
    || list.find((t) => (t.label || "").toLowerCase().includes(want))
    || list.find((t) => want.includes((t.label || "").toLowerCase()) && t.label)
    || null;
}
