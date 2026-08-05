// Shell.jsx — everything between opening the page and the household appearing.
//
// Sign in, pick a household, or make one. It wraps App.jsx rather than being
// woven into it, which is why the main UI needed no changes: by the time App
// renders, session.js holds the household key and api.js transparently seals
// and opens the document underneath it.

import React, { useCallback, useEffect, useState } from "react";
import App from "./App.jsx";
import * as session from "./lib/session.js";
import { seed } from "./lib/document.js";

/* ------------------------------------------------------------ furniture --- */

const Card = ({ title, subtitle, children, footer }) => (
  <div className="min-h-screen flex items-center justify-center bg-slate-900 p-4">
    <div className="w-full max-w-sm bg-slate-800 rounded-2xl shadow-xl p-6 text-slate-100">
      <h1 className="text-xl font-semibold mb-1">{title}</h1>
      {subtitle && <p className="text-sm text-slate-400 mb-5">{subtitle}</p>}
      {children}
      {footer && <div className="mt-5 pt-4 border-t border-slate-700 text-sm text-slate-400">{footer}</div>}
    </div>
  </div>
);

const Field = ({ label, hint, ...props }) => (
  <label className="block mb-3">
    <span className="block text-sm mb-1 text-slate-300">{label}</span>
    <input
      {...props}
      className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2
                 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    />
    {hint && <span className="block text-xs text-slate-500 mt-1">{hint}</span>}
  </label>
);

const Button = ({ children, busy, ...props }) => (
  <button
    {...props}
    disabled={busy || props.disabled}
    className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50
               px-4 py-2 font-medium transition"
  >
    {busy ? "Working…" : children}
  </button>
);

const Problem = ({ children }) =>
  children ? (
    <div role="alert" className="mb-3 rounded-lg bg-rose-950 border border-rose-800 px-3 py-2 text-sm text-rose-200">
      {children}
    </div>
  ) : null;

/* ---------------------------------------------------------------- stages --- */

function SignIn({ onDone, allowSignup }) {
  const [mode, setMode] = useState("in");
  const [form, setForm] = useState({ email: "", password: "", confirm: "", displayName: "", totp: "" });
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);

    if (mode === "up") {
      if (form.password.length < 12) {
        return setError("Use at least 12 characters. This password is the only thing that can decrypt your household — nobody can reset it for you.");
      }
      if (form.password !== form.confirm) return setError("The two passwords do not match.");
    }

    setBusy(true);
    try {
      if (mode === "up") {
        await session.register({ email: form.email, password: form.password, displayName: form.displayName });
      } else {
        await session.signIn({ email: form.email, password: form.password, totp: form.totp || undefined });
      }
      onDone();
    } catch (err) {
      if (err.code === "totp_required") { setNeedsTotp(true); setError("Enter the code from your authenticator app."); }
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={mode === "up" ? "Create your account" : "Sign in to HouseHub"}
      subtitle={mode === "up"
        ? "Your password never leaves this device."
        : "Your household is encrypted; only your password opens it."}
      footer={allowSignup && (
        <button className="underline hover:text-slate-200"
                onClick={() => { setMode(mode === "up" ? "in" : "up"); setError(null); }}>
          {mode === "up" ? "I already have an account" : "Create an account"}
        </button>
      )}
    >
      <form onSubmit={submit}>
        <Problem>{error}</Problem>
        {mode === "up" && (
          <Field label="Your name" value={form.displayName} onChange={set("displayName")}
                 autoComplete="name" required />
        )}
        <Field label="Email" type="email" value={form.email} onChange={set("email")}
               autoComplete="username" required />
        <Field
          label="Password" type="password" value={form.password} onChange={set("password")}
          autoComplete={mode === "up" ? "new-password" : "current-password"} required
          hint={mode === "up"
            ? "There is no password reset. If you lose this, your household cannot be recovered — by us or by anyone."
            : undefined}
        />
        {mode === "up" && (
          <Field label="Confirm password" type="password" value={form.confirm}
                 onChange={set("confirm")} autoComplete="new-password" required />
        )}
        {needsTotp && (
          <Field label="Two-factor code" value={form.totp} onChange={set("totp")}
                 inputMode="numeric" autoComplete="one-time-code" />
        )}
        <Button busy={busy}>{mode === "up" ? "Create account" : "Sign in"}</Button>
      </form>
    </Card>
  );
}

function PickHousehold({ households, onOpen, onCreate, onSignOut }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const open = async (id) => {
    setBusy(true); setError(null);
    try { await onOpen(id); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  if (!households.length) return <CreateHousehold onCreate={onCreate} onSignOut={onSignOut} />;

  return (
    <Card title="Your households"
          footer={<button className="underline hover:text-slate-200" onClick={onSignOut}>Sign out</button>}>
      <Problem>{error}</Problem>
      <div className="space-y-2 mb-4">
        {households.map((h) => (
          <button key={h.id} disabled={busy} onClick={() => open(h.id)}
                  className="w-full text-left rounded-lg bg-slate-900 hover:bg-slate-700 border
                             border-slate-700 px-3 py-2 disabled:opacity-50">
            {/* The name is encrypted under the household key, so it cannot be
                shown until the household is opened. */}
            <div className="font-medium">Household</div>
            <div className="text-xs text-slate-400">
              {h.role}{h.status === "suspended" ? " · read-only" : ""}
            </div>
          </button>
        ))}
      </div>
      <button className="text-sm underline text-slate-400 hover:text-slate-200"
              onClick={() => onCreate(null)}>
        Start a new household
      </button>
    </Card>
  );
}

function CreateHousehold({ onCreate, onSignOut }) {
  const [name, setName] = useState("Our home");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await onCreate(name); } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Card title="Set up your household"
          subtitle="A fresh encryption key is generated on this device. The server never sees it."
          footer={<button className="underline hover:text-slate-200" onClick={onSignOut}>Sign out</button>}>
      <form onSubmit={submit}>
        <Problem>{error}</Problem>
        <Field label="What do you call home?" value={name} onChange={(e) => setName(e.target.value)}
               required maxLength={60} />
        <Button busy={busy}>Create household</Button>
      </form>
    </Card>
  );
}

function Waiting({ message }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 text-slate-400">
      {message}
    </div>
  );
}

/* ----------------------------------------------------------------- shell --- */

export default function Shell() {
  const [stage, setStage] = useState("loading");
  const [households, setHouseholds] = useState([]);
  const [config, setConfig] = useState({ allowSignup: true });
  const [fatal, setFatal] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const list = await session.listHouseholds();
      setHouseholds(list);
      setStage(list.length ? "pick" : "create");
    } catch (err) {
      if (err.status === 401) setStage("signin");
      else setFatal(err.message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try { setConfig(await session.request("GET", "api/config")); } catch { /* defaults */ }
      // A session cookie may already be valid, but the keys are memory-only and
      // are gone after a reload -- so a returning visitor still signs in. That
      // is the cost of never persisting key material, and it is deliberate.
      setStage("signin");
    })();
  }, []);

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
    setHouseholds([]);
    setStage("signin");
  };

  if (fatal) {
    return <Card title="Something went wrong"><Problem>{fatal}</Problem></Card>;
  }

  switch (stage) {
    case "loading":
      return <Waiting message="Loading…" />;
    case "signin":
      return <SignIn allowSignup={config.allowSignup} onDone={refresh} />;
    case "pick":
      return <PickHousehold households={households} onOpen={openHousehold}
                            onCreate={createHousehold} onSignOut={signOut} />;
    case "create":
      return <CreateHousehold onCreate={createHousehold} onSignOut={signOut} />;
    case "ready":
      // From here down, nothing knows encryption exists.
      return <App />;
    default:
      return <Waiting message="Loading…" />;
  }
}
