// project-events.js — project work showing up on the calendar.
//
// Ryan: "With the projects, when a subtask has a date, add it to the calendar.
// Also make it so that you can choose which synced calendar that it applies to."
//
// A dated stage is already a commitment to do something on a day. It was only
// visible inside the project, so the calendar could look empty on a Saturday
// that three stages were pointing at.
//
// These events are DERIVED, never stored. The project remains the single record
// of what is planned; the calendar is a view of it. Storing copies would mean
// two things to keep in step and a reconciliation bug the first time somebody
// moved a stage. The cost is that they cannot be edited from the calendar --
// which is the right way round, since the project is where the work lives.

/** A stable, reproducible id. The same stage always yields the same event. */
export const projectEventId = (projectId, stageId) =>
  `project:${projectId}:${stageId || "date"}`;

/**
 * Derive calendar events from a project's dated stages.
 *
 * A project with stages contributes one event per dated stage, titled with the
 * stage so the calendar says "Kitchen — order tiles" rather than repeating the
 * project name three times on one day. A project without stages contributes its
 * own planned days.
 */
export function eventsForProject(project) {
  if (!project || !project.id) return [];
  const out = [];
  const stages = Array.isArray(project.stages) ? project.stages : [];
  const target = project.calendarId || "";

  if (stages.length) {
    for (const st of stages) {
      if (!st || !st.date) continue;
      out.push({
        id: projectEventId(project.id, st.id),
        title: stages.length > 1 && st.title ? `${project.title} — ${st.title}` : (project.title || "Project"),
        date: st.date,
        time: st.time || "",
        allDay: !st.time,
        personId: st.personId || project.personId || "",
        source: "project",
        projectId: project.id,
        stageId: st.id || null,
        calendarId: target,
        done: Boolean(st.done),
        readOnly: true,
      });
    }
    return out;
  }

  for (const date of [...new Set(project.dates || [])].sort()) {
    if (!date) continue;
    out.push({
      id: projectEventId(project.id, `d${date}`),
      title: project.title || "Project",
      date,
      time: "",
      allDay: true,
      personId: project.personId || "",
      source: "project",
      projectId: project.id,
      stageId: null,
      calendarId: target,
      done: false,
      readOnly: true,
    });
  }
  return out;
}

/** Every project's dated work, as calendar events. */
export function projectEvents(projects) {
  return (projects || []).flatMap(eventsForProject);
}

/**
 * The events a given synced calendar is responsible for pushing outward.
 *
 * A project with no calendar chosen stays inside HouseHub. That is the default
 * on purpose: a household's renovation plan should not start appearing on a
 * shared work calendar because somebody added a stage.
 */
export function projectEventsFor(projects, calendarId) {
  if (!calendarId) return [];
  return projectEvents(projects).filter((e) => e.calendarId === calendarId);
}

/* ------------------------------------------------------- outbound sync --- */

/**
 * Everything that should exist on one synced calendar.
 *
 * The complete set, not a delta: the server compares it against what it last
 * wrote and works out the difference. Sending a delta would mean the client
 * tracking remote state it cannot see.
 *
 * Two sources feed it -- the household's own events, and dated project work --
 * and both only travel if somebody pointed them at this calendar by name.
 * Anything with no calendar chosen stays inside HouseHub.
 */
export function eventsForSync(data, calendarId) {
  if (!data || !calendarId) return [];

  const own = (data.events || [])
    .filter((e) => e && e.id && e.date && e.calendarId === calendarId)
    .map((e) => ({
      id: e.id,
      title: e.title || "(No title)",
      date: e.date,
      time: e.time || "",
      endTime: e.endTime || "",
      allDay: !e.time,
      notes: e.notes || "",
      location: e.location || "",
    }));

  const fromProjects = projectEventsFor(data.projects, calendarId).map((e) => ({
    id: e.id,
    title: e.title,
    date: e.date,
    time: e.time || "",
    endTime: "",
    allDay: e.allDay,
    notes: "",
    location: "",
  }));

  /* An id collision between the two would make one silently replace the other
     on the remote calendar, so project ids are already namespaced ("project:")
     and cannot collide with an event's own id. Deduped anyway, because relying
     on that invariant without checking it is how it stops being true. */
  const seen = new Set();
  return [...own, ...fromProjects].filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}
