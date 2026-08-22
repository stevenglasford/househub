// completion.js — who ticked a chore off, and how we know.
//
// The original model stored `chore.done[dateKey]` as `true`, a person id, or the
// string "skipped". That answers "is it done" and not much else. Once a
// household wants a record -- a parent seeing a child do more than was asked, or
// one partner quietly covering the other's week -- it needs to answer three more
// questions: who actually did it, who it was assigned to, and how confident we
// are about the first one.
//
// So a completion may now also be an object:
//
//   { by, actorUserId, byType, source, at, locked }
//
//   by           person id in the household document, when we can name one
//   actorUserId  the *account* that ticked it -- the authoritative fact
//   byType       'user'    a signed-in member; attribution is trustworthy
//                'display' a shared screen; anyone in the room could have done it
//                'onBehalf' somebody said a third person did it -- second-hand,
//                          so credited to them but still open to correction
//   source       the display's name, when the tick came from one
//   at           timestamp
//   locked       set for signed-in completions: cannot be reassigned afterwards
//
// The old shapes are still read, so no household needs migrating and a document
// written by an older client keeps working.
//
// WHY 'display' COMPLETIONS ARE EDITABLE AND 'user' ONES ARE NOT. A signed-in
// person ticking their own box is a claim they made about themselves, under
// their own account -- rewriting it later would make the archive a record of
// what someone decided the past should look like. A shared iPad in the kitchen
// knows only that *somebody* pressed the button, so the honest thing is to
// record the screen as the source and let a human attribute it afterwards.

export const SKIPPED = "skipped";

export const isSkipped = (v) =>
  v === SKIPPED || (v !== null && typeof v === "object" && v.skipped === true);

export const isCompletion = (v) => Boolean(v) && !isSkipped(v);

/** Normalise any stored shape into one record, or null. */
export function completionOf(mark) {
  if (!isCompletion(mark)) return null;
  if (typeof mark === "string") {
    // Legacy: the person id, with no idea who pressed it or when.
    return { by: mark, actorUserId: null, byType: "legacy", source: null, at: null, locked: false };
  }
  if (mark === true) {
    return { by: "", actorUserId: null, byType: "legacy", source: null, at: null, locked: false };
  }
  return {
    by: mark.by ?? "",
    actorUserId: mark.actorUserId ?? null,
    byType: mark.byType || "legacy",
    source: mark.source || null,
    at: mark.at || null,
    locked: Boolean(mark.locked),
    /* Whose turn this was, when somebody else covered it. Distinct from `by`,
       which is who actually did the work. The rotation needs both: the work is
       credited to the person who did it, but the turn belongs to -- and stays
       with -- the person who owed it. */
    onBehalfOf: mark.onBehalfOf ?? null,
    /* True when nobody said who did it and the assignee was assumed. The
       difference matters: a presumed credit is a good guess to be corrected,
       a stated one is somebody's account of themselves. */
    presumed: Boolean(mark.presumed),
  };
}

/** The person id credited with a completion, if any. */
export const completedBy = (mark) => completionOf(mark)?.by || "";

/**
 * Build a completion for the current actor.
 *
 * `actor` comes from lib/session: either a signed-in member or a display.
 */
export function markCompleted(actor, { fallbackPersonId = "" } = {}) {
  if (actor?.isDisplay) {
    /* A shared screen cannot know who pressed it, so it assumes the person
       whose turn it was -- and records that this is an assumption.
       
       It used to name nobody, which was strictly more truthful and worse in
       practice: the row read "Who did it?" forever, because in a kitchen nobody
       goes back to answer a question the wall is asking. Naming the likely
       person and flagging it as presumed gets the common case right, keeps the
       uncommon case visible, and leaves it one tap to correct. */
    return {
      by: fallbackPersonId || "",
      presumed: Boolean(fallbackPersonId),
      actorUserId: null,
      byType: "display",
      source: actor.displayName || "Shared display",
      at: Date.now(),
      locked: false,
    };
  }
  return {
    by: actor?.personId || fallbackPersonId || "",
    actorUserId: actor?.userId || null,
    byType: "user",
    source: null,
    at: Date.now(),
    // A signed-in completion is a statement about yourself. It stands.
    locked: true,
  };
}

/**
 * May `actor` un-tick this completion?
 *
 * Your own completion is yours to undo -- and undoing it frees the chore for
 * somebody else to claim, which is the point. A completion made on a shared
 * display belongs to nobody in particular, so any member may undo it.
 */
export function canUncheck(mark, actor) {
  const c = completionOf(mark);
  if (!c) return true;
  // None of these is a first-person claim, so nobody's word is being overridden
  // by undoing one.
  if (c.byType === "display" || c.byType === "legacy" || c.byType === "onBehalf") return true;

  /* A shared screen may undo a signed-in person's tick, which it could not at
     first. The original reasoning -- that a screen cannot know who is standing
     at it, so it should not overrule somebody's claim about themselves -- reads
     well and failed in the kitchen. Somebody ticks the wrong row from their
     phone; the only device in the room refuses to fix it; the list is wrong
     until whoever did it finds a laptop.
     
     The screen is already trusted to tick a chore off. Untricking one is the
     same act by the same anonymous person, and the archive still records what
     happened rather than pretending it did not. */
  if (actor?.isDisplay) return true;
  return c.actorUserId === actor?.userId;
}

/**
 * May `actor` change who is credited?
 *
 * The ex-post-facto attribution: the iPad recorded that the bins went out, and
 * somebody says it was Sam.
 *
 * A shared display may do this too, which it could not at first. The original
 * reasoning was that a screen cannot know who is standing at it -- true, but it
 * proves too much: that same screen is already trusted to tick the chore off in
 * the first place. Naming who did it is the same act by the same anonymous
 * person, and refusing it only meant the correction had to wait for somebody to
 * find a laptop, which in practice meant it never happened.
 *
 * What a display still cannot do is overwrite a *locked* completion. Those are
 * first-person claims made by a signed-in member about themselves, and nothing
 * anonymous gets to rewrite them.
 */
export function canReattribute(mark, actor) {
  const c = completionOf(mark);
  if (!c) return false;
  return !c.locked && (c.byType === "display" || c.byType === "legacy" || c.byType === "onBehalf");
}

export function reattribute(mark, personId, actor) {
  const c = completionOf(mark);
  if (!c) return mark;
  return {
    ...c,
    by: personId || "",
    // Somebody has now said who it was, so it is no longer an assumption --
    // otherwise a corrected row would keep wearing the "assumed" marker and
    // invite the same correction again.
    presumed: false,
    // Kept, so the archive still shows the completion came off a screen and was
    // attributed later rather than claimed at the time.
    attributedBy: actor?.userId || null,
    // When the correction itself came from a shared screen, say which one. The
    // record should not imply a person stood behind it when none is known.
    attributedOn: actor?.isDisplay ? (actor.displayName || "a shared display") : null,
    attributedAt: Date.now(),
  };
}

/* --------------------------------------------------------------- archive --- */

// What may be archived. Adding a collection here is all it takes to offer it.
export const ARCHIVABLE = {
  chores: "Chores",
  tasks: "To-dos",
  projects: "House projects",
  grocery: "Grocery purchases",
};

export const archiveEnabled = (doc, kind) =>
  Boolean(doc?.archiveSettings?.[kind]);

/**
 * Append one completion to the archive.
 *
 * Append-only while the archive is on: entries are never rewritten and never
 * removed, because a record you can quietly edit is not a record. Turning the
 * archive off is the only thing that clears it, and that takes every admin
 * (see routes/proposals.js).
 */
export function appendArchive(doc, kind, entry) {
  if (!archiveEnabled(doc, kind)) return doc;
  const archive = { ...(doc.archive || {}) };
  const list = Array.isArray(archive[kind]) ? archive[kind] : [];
  archive[kind] = [...list, { id: entryId(), at: Date.now(), ...entry }];
  return { ...doc, archive };
}

/** Remove an archived entry for an action that was undone. */
export function retractArchive(doc, kind, match) {
  const list = doc?.archive?.[kind];
  if (!Array.isArray(list) || !list.length) return doc;
  // Only the most recent matching entry, so an undo cannot wipe history.
  for (let i = list.length - 1; i >= 0; i--) {
    if (match(list[i])) {
      const next = [...list];
      next.splice(i, 1);
      return { ...doc, archive: { ...doc.archive, [kind]: next } };
    }
  }
  return doc;
}

const entryId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** A readable description of who did something, for the archive list. */
export function describeActor(entry, personById) {
  if (entry.byType === "display") {
    const who = entry.by ? personById(entry.by)?.name : null;
    return who
      ? `${who} — attributed after the fact, ticked on ${entry.source || "a shared display"}`
      : `Ticked on ${entry.source || "a shared display"}`;
  }
  if (entry.byType === "onBehalf") {
    const who = entry.by ? personById(entry.by)?.name : null;
    return who ? `${who} — recorded by someone else` : "Recorded by someone else";
  }
  if (entry.byType === "user") {
    return personById(entry.by)?.name || entry.actorName || "A member";
  }
  return personById(entry.by)?.name || "Unknown";
}

/* --------------------------------------------------------------- toggling --- */

/**
 * Tick a chore off, or un-tick it, recording who and how.
 *
 * Returns the new document. Throws a plain Error with a message meant for a
 * person when the action is not allowed -- unticking somebody else's claim, for
 * instance -- so the caller can just show it.
 */
export function toggleChore(doc, choreId, dateKey, actor, { assigneeOf } = {}) {
  const chores = doc.chores || [];
  const chore = chores.find((c) => c.id === choreId);
  if (!chore) return doc;

  const mark = chore.done?.[dateKey];
  const wasDone = isCompletion(mark);

  if (wasDone && !canUncheck(mark, actor)) {
    const c = completionOf(mark);
    throw new Error(
      c.byType === "user"
        ? "Only the person who ticked this off can un-tick it."
        : "A display cannot undo somebody's completion."
    );
  }

  const done = { ...(chore.done || {}) };
  let next = doc;

  if (wasDone) {
    delete done[dateKey];
    // Undoing removes the archive entry it created. This is the one case where
    // an archived row disappears, and it has to be: the alternative is a
    // permanent record of something that did not happen.
    next = retractArchive(next, "chores", (e) => e.choreId === choreId && e.dateKey === dateKey);
  } else {
    const completion = markCompleted(actor, {
      fallbackPersonId: assigneeOf ? assigneeOf(chore, dateKey) : chore.personId,
    });
    done[dateKey] = completion;
    next = appendArchive(next, "chores", {
      choreId,
      dateKey,
      title: chore.title,
      // Kept alongside who did it, so the archive can show one person covering
      // another's chore -- which is the whole reason for recording both.
      assignedTo: assigneeOf ? assigneeOf(chore, dateKey) : (chore.personId || ""),
      by: completion.by,
      actorUserId: completion.actorUserId,
      byType: completion.byType,
      source: completion.source,
      completedAt: completion.at,
    });
  }

  next = {
    ...next,
    chores: (next.chores || []).map((c) => (c.id === choreId ? { ...c, done } : c)),
  };
  return next;
}

/**
 * Tick a chore off on somebody else's behalf: "it was Sam".
 *
 * A signed-in completion is a statement about yourself, which is why
 * markCompleted locks it. Saying somebody *else* did it is a different claim
 * entirely -- it is second-hand, and the person credited never touched the
 * screen. Recording it as though they had ticked it themselves would forge a
 * first-person claim in the archive, and locking it would leave the one person
 * who could correct it unable to.
 *
 * So it is stored for what it is: credited to them, recorded by you, and still
 * open to correction. Which is also what a shared display produces, for the
 * same reason -- neither knows first-hand who did the thing.
 */
export function completeOnBehalf(doc, choreId, dateKey, personId, actor, { assigneeOf } = {}) {
  const chore = (doc.chores || []).find((c) => c.id === choreId);
  if (!chore) return doc;
  if (isCompletion(chore.done?.[dateKey])) {
    // Already ticked: this is a correction, not a new completion.
    return attributeChore(doc, choreId, dateKey, personId, actor);
  }

  /* Whose turn it was before anyone covered it. Captured here, from the
     rotation as it stood, because once the completion is written the rotation
     would compute a different answer from its own output. */
  const owedBy = assigneeOf ? assigneeOf(chore, dateKey) : (chore.personId || "");

  const completion = {
    by: personId || "",
    onBehalfOf: owedBy && owedBy !== personId ? owedBy : null,
    actorUserId: actor?.userId || null,
    byType: "onBehalf",
    source: actor?.isDisplay ? (actor.displayName || "Shared display") : null,
    at: Date.now(),
    locked: false,
  };

  const next = appendArchive(doc, "chores", {
    choreId,
    dateKey,
    title: chore.title,
    assignedTo: owedBy,
    by: completion.by,
    actorUserId: completion.actorUserId,
    byType: completion.byType,
    source: completion.source,
    completedAt: completion.at,
  });

  return {
    ...next,
    chores: (next.chores || []).map((c) =>
      c.id === choreId ? { ...c, done: { ...(c.done || {}), [dateKey]: completion } } : c
    ),
  };
}

/** Credit an existing display completion to a person, after the fact. */
export function attributeChore(doc, choreId, dateKey, personId, actor) {
  const chore = (doc.chores || []).find((c) => c.id === choreId);
  if (!chore) return doc;
  const mark = chore.done?.[dateKey];
  if (!canReattribute(mark, actor)) {
    throw new Error("That completion cannot be reassigned.");
  }

  const updated = reattribute(mark, personId, actor);
  const archive = { ...(doc.archive || {}) };
  if (Array.isArray(archive.chores)) {
    archive.chores = archive.chores.map((e) =>
      e.choreId === choreId && e.dateKey === dateKey
        ? { ...e, by: personId || "", attributedBy: actor?.userId || null, attributedAt: Date.now() }
        : e
    );
  }

  return {
    ...doc,
    archive,
    chores: doc.chores.map((c) =>
      c.id === choreId ? { ...c, done: { ...c.done, [dateKey]: updated } } : c
    ),
  };
}

/**
 * Clear an archive. Only reachable once every admin has approved the proposal
 * that authorises it (routes/proposals.js) -- this function does not check,
 * because by the time it runs the decision has already been made and recorded.
 */
export function wipeArchive(doc, collections) {
  const archive = { ...(doc.archive || {}) };
  const settings = { ...(doc.archiveSettings || {}) };
  for (const kind of collections) {
    delete archive[kind];
    settings[kind] = false;
  }
  return { ...doc, archive, archiveSettings: settings };
}
