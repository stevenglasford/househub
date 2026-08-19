// subtasks.js — the smaller pieces of a to-do, and notes attached to a chore.
//
// Two different needs that look similar and are not:
//
//   A TASK has steps. "Renew the car tabs" is really: find the paperwork, pay
//   the fee, put the sticker on. They belong to the task itself and they are
//   done once.
//
//   A CHORE recurs, so a note about it belongs to *one occurrence*, not to the
//   chore. "Bins out" every Tuesday, and on one particular Tuesday the lorry
//   never came. Attaching that to the chore would make it look like a standing
//   instruction; attaching it to the day it happened is what somebody actually
//   meant.
//
// Hence two shapes:
//
//   task.steps  = [{ id, title, done }]
//   chore.notes = { "YYYY-MM-DD": "the lorry never came" }
//
// Both are optional and absent by default, so no document needs migrating.

const newId = () => Math.random().toString(36).slice(2, 9);

/* ------------------------------------------------------------- task steps --- */

export const stepsOf = (task) => (Array.isArray(task?.steps) ? task.steps : []);

export const stepProgress = (task) => {
  const steps = stepsOf(task);
  if (!steps.length) return null;
  return { done: steps.filter((s) => s.done).length, total: steps.length };
};

export function addStep(task, title) {
  const text = String(title || "").trim();
  if (!text) return task;
  return { ...task, steps: [...stepsOf(task), { id: newId(), title: text, done: false }] };
}

export function toggleStep(task, stepId) {
  return { ...task, steps: stepsOf(task).map((s) => (s.id === stepId ? { ...s, done: !s.done } : s)) };
}

export function removeStep(task, stepId) {
  return { ...task, steps: stepsOf(task).filter((s) => s.id !== stepId) };
}

export function renameStep(task, stepId, title) {
  const text = String(title || "").trim();
  return { ...task, steps: stepsOf(task).map((s) => (s.id === stepId ? { ...s, title: text || s.title } : s)) };
}

/**
 * Should ticking the task itself be offered?
 *
 * A task with unfinished steps can still be marked done -- somebody may decide
 * the rest does not matter -- but the UI shows the count so it is a decision
 * rather than an accident.
 */
export const stepsOutstanding = (task) => stepsOf(task).filter((s) => !s.done).length;

/* ------------------------------------------------------- chore occurrence --- */

export const choreNotes = (chore) =>
  (chore?.notes && typeof chore.notes === "object" && !Array.isArray(chore.notes)) ? chore.notes : {};

export const choreNoteOn = (chore, dateKey) => choreNotes(chore)[dateKey] || "";

/**
 * Attach a note to one occurrence of a recurring chore.
 *
 * Keyed by date, so "the lorry never came" belongs to that Tuesday and not to
 * every Tuesday from now on. An empty note removes the entry rather than
 * storing a blank, so the document does not accumulate keys for every day
 * somebody opened the box and changed their mind.
 */
export function setChoreNote(chore, dateKey, text) {
  const notes = { ...choreNotes(chore) };
  const trimmed = String(text || "").trim();
  if (trimmed) notes[dateKey] = trimmed;
  else delete notes[dateKey];
  return Object.keys(notes).length ? { ...chore, notes } : omitNotes(chore);
}

function omitNotes(chore) {
  const { notes, ...rest } = chore;
  return rest;
}

/** Every note on a chore, newest first — for the history view. */
export function noteHistory(chore) {
  return Object.entries(choreNotes(chore))
    .map(([dateKey, text]) => ({ dateKey, text }))
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey));
}

/* ------------------------------------------------------- chore checklist --- */

/**
 * A recurring chore's checklist.
 *
 * Titles only, with no completion state, and that is deliberate. A chore comes
 * round every week; "wheelie bin, recycling, garden waste" is what the job
 * involves every time, not something to be ticked once and left ticked. Storing
 * a done flag would mean either wiping it on every occurrence or keying it by
 * date -- and the second is what the per-occurrence *note* is already for.
 */
export const choreChecklist = (chore) =>
  (Array.isArray(chore?.checklist) ? chore.checklist.filter((s) => typeof s === "string" && s.trim()) : []);

export function setChoreChecklist(chore, items) {
  const clean = (items || []).map((s) => String(s).trim()).filter(Boolean);
  if (!clean.length) {
    const { checklist, ...rest } = chore;
    return rest;
  }
  return { ...chore, checklist: clean };
}

/* ------------------------------------------------------------- task note --- */

export const taskNote = (task) => (typeof task?.note === "string" ? task.note : "");

export function setTaskNote(task, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    const { note, ...rest } = task;
    return rest;
  }
  return { ...task, note: trimmed };
}
