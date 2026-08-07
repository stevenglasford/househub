// Shell.jsx — everything between opening the page and the household appearing.
//
// Sign in, choose a household, or make one. It wraps App rather than being woven
// into it, which is why the main UI needed no changes: by the time App renders,
// session.js holds the household key and api.js seals and opens the document
// underneath it.

import React, { useCallback, useEffect, useState } from "react";
import App from "./App.jsx";
import * as session from "./lib/session.js";
import { seed } from "./lib/document.js";
import { Card, Field, Button, Problem, SignIn } from "./components/auth-ui.jsx";

/* ---------------------------------------------------------------- picker --- */

const relativeDay = (iso) => {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso)) / 86400e3);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
};

function HouseholdRow({ hh, onOpen, onArchive, onDelete, busy }) {
  const [menu, setMenu] = useState(false);

  const subtitle = hh.pendingApproval
    ? "Waiting for an admin to let you in — ask them to check your key fingerprint"
    : [
        hh.role,
        `${hh.memberCount} ${hh.memberCount === 1 ? "person" : "people"}`,
        hh.updatedAt ? `active ${relativeDay(hh.updatedAt)}` : null,
      ].filter(Boolean).join(" · ");

  return (
    <div className="rounded-lg bg-slate-900 border border-slate-700 mb-2 overflow-hidden">
      <div className="flex items-stretch">
        <button
          disabled={busy || hh.pendingApproval}
          onClick={() => onOpen(hh.id)}
          className="flex-1 text-left px-3 py-2.5 hover:bg-slate-700 disabled:opacity-60 disabled:hover:bg-transparent"
        >
          <div className="font-medium">
            {/* A name only exists once it has been decrypted here. Anything else
                means an older household, or a key we could not unwrap. */}
            {hh.name || (hh.unlockable ? "Untitled household" : "Locked household")}
            {hh.archived && <span className="text-slate-500 font-normal"> · archived</span>}
          </div>
          <div className="text-xs text-slate-400">{subtitle}</div>
        </button>
        <button
          onClick={() => setMenu((m) => !m)}
          aria-label="Household options"
          className="px-3 text-slate-500 hover:text-slate-200 border-l border-slate-700"
        >
          ⋯
        </button>
      </div>

      {menu && (
        <div className="px-3 py-2 border-t border-slate-700 bg-slate-950 text-sm flex gap-3 flex-wrap">
          <button className="underline text-slate-300 hover:text-white"
                  onClick={() => { setMenu(false); onArchive(hh, !hh.archived); }}>
            {hh.archived ? "Restore to my list" : "Archive"}
          </button>
          <button className="underline text-rose-300 hover:text-rose-200"
                  onClick={() => { setMenu(false); onDelete(hh); }}>
            Delete permanently
          </button>
        </div>
      )}
    </div>
  );
}

function PickHousehold({ households, onOpen, onCreate, onSignOut, refresh, user }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  const live = households.filter((h) => !h.archived);
  const archived = households.filter((h) => h.archived);

  const run = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const archive = (hh, archived) =>
    run(async () => { await session.archiveHousehold(hh.id, archived); await refresh(); });

  const remove = (hh) => {
    // Two confirmations, and the second requires typing the name. This destroys
    // years of a shared life and there is no backup on the server that could
    // bring it back -- the data is encrypted under a key only members hold.
    const label = hh.name || "this household";
    if (!confirm(
      `Delete ${label}?\n\n` +
      `This destroys the calendar, meals, chores, lists, notes and history permanently. ` +
      `Nobody can recover it — not you, and not whoever runs this server.\n\n` +
      `If you just want it out of the way, choose Archive instead.`
    )) return;
    const typed = prompt(`Type the household name to confirm deletion:\n\n${label}`);
    if (typed !== label) {
      if (typed !== null) alert("That did not match. Nothing was deleted.");
      return;
    }
    return run(async () => { await session.deleteHousehold(hh.id); await refresh(); });
  };

  if (!households.length) return <CreateHousehold onCreate={onCreate} onSignOut={onSignOut} />;

  return (
    <Card
      title="Your households"
      subtitle={user?.email}
      footer={<button className="underline hover:text-slate-200" onClick={onSignOut}>Sign out</button>}
    >
      <Problem>{error}</Problem>

      {live.map((hh) => (
        <HouseholdRow key={hh.id} hh={hh} busy={busy}
                      onOpen={onOpen} onArchive={archive} onDelete={remove} />
      ))}

      {archived.length > 0 && (
        <div className="mt-3">
          <button className="text-xs underline text-slate-500 hover:text-slate-300"
                  onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide" : "Show"} archived ({archived.length})
          </button>
          {showArchived && (
            <div className="mt-2">
              {archived.map((hh) => (
                <HouseholdRow key={hh.id} hh={hh} busy={busy}
                              onOpen={onOpen} onArchive={archive} onDelete={remove} />
              ))}
            </div>
          )}
        </div>
      )}

      <button className="mt-4 text-sm underline text-slate-400 hover:text-slate-200"
              onClick={() => onCreate(null)}>
        Start a new household
      </button>
    </Card>
  );
}

function CreateHousehold({ onCreate, onSignOut, onCancel }) {
  const [name, setName] = useState("Our home");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await onCreate(name); } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Card
      title="Set up your household"
      subtitle="A fresh encryption key is generated on this device. The server never sees it."
      footer={
        <button className="underline hover:text-slate-200" onClick={onCancel || onSignOut}>
          {onCancel ? "Back" : "Sign out"}
        </button>
      }
    >
      <form onSubmit={submit}>
        <Problem>{error}</Problem>
        <Field label="What do you call home?" value={name} onChange={(e) => setName(e.target.value)}
               required maxLength={60} />
        <Button busy={busy}>Create household</Button>
      </form>
    </Card>
  );
}

const Waiting = ({ message }) => (
  <div className="min-h-screen flex items-center justify-center bg-slate-900 text-slate-400">{message}</div>
);

/* ----------------------------------------------------------------- shell --- */

export default function Shell() {
  const [stage, setStage] = useState("signin");
  const [households, setHouseholds] = useState([]);
  const [config, setConfig] = useState({ allowSignup: true });
  const [user, setUser] = useState(null);
  const [fatal, setFatal] = useState(null);

  const refresh = useCallback(async () => {
    const list = await session.listHouseholds();
    setHouseholds(list);
    return list;
  }, []);

  const afterAuth = useCallback(async () => {
    try {
      const me = await session.loadMe();
      setUser(me);
      const list = await refresh();
      // One household and nothing to choose between: go straight in. Making
      // somebody pick from a list of one is a click that teaches nothing.
      const usable = list.filter((h) => !h.archived && !h.pendingApproval);
      if (usable.length === 1) {
        await session.openHousehold(usable[0].id);
        return setStage("ready");
      }
      // Somebody waiting on an admin has a household -- they just cannot open
      // it yet. Sending them to "create a household" is how you end up with a
      // second, empty home and a confused person.
      setStage(list.length ? "pick" : "create");
    } catch (err) {
      if (err.status === 401) setStage("signin");
      else setFatal(err.message);
    }
  }, [refresh]);

  useEffect(() => {
    session.request("GET", "api/config").then(setConfig).catch(() => {});
    // Keys are memory-only, so a reload always means signing in again. That is
    // the cost of never persisting key material anywhere.
    setStage("signin");
  }, []);

  // Let the app ask to come back here to switch households.
  useEffect(() => {
    const onSwitch = () => { session.closeHousehold(); refresh().then(() => setStage("pick")); };
    window.addEventListener("househub:switch-household", onSwitch);
    return () => window.removeEventListener("househub:switch-household", onSwitch);
  }, [refresh]);

  const openHousehold = async (id) => {
    await session.openHousehold(id);
    setStage("ready");
  };

  const createHousehold = async (name) => {
    if (name === null) return setStage("create");
    await session.createHousehold(name, seed());
    setStage("ready");
  };

  const signOut = async () => {
    await session.signOut();
    setHouseholds([]); setUser(null);
    setStage("signin");
  };

  if (fatal) return <Card title="Something went wrong"><Problem>{fatal}</Problem></Card>;

  switch (stage) {
    case "signin":
      return <SignIn allowSignup={config.allowSignup} onDone={afterAuth} />;
    case "pick":
      return <PickHousehold households={households} user={user} onOpen={openHousehold}
                            onCreate={createHousehold} onSignOut={signOut} refresh={refresh} />;
    case "create":
      return <CreateHousehold onCreate={createHousehold} onSignOut={signOut}
                              onCancel={households.length ? () => setStage("pick") : null} />;
    case "ready":
      return <App />;
    default:
      return <Waiting message="Loading…" />;
  }
}
