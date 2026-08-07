// auth-ui.jsx — the sign-in form and the furniture around it.
//
// Extracted from Shell so the invite flow can use it too. Previously somebody
// following an invitation while signed out was told "sign in, then open this
// link again" -- which discards the token they were sent and leaves them to dig
// it back out of a message thread. Now the form appears inline and the join
// continues where it left off.

import React, { useState } from "react";
import * as session from "../lib/session.js";

export const Card = ({ title, subtitle, children, footer }) => (
  <div className="min-h-screen flex items-center justify-center bg-slate-900 p-4">
    <div className="w-full max-w-sm bg-slate-800 rounded-2xl shadow-xl p-6 text-slate-100">
      <h1 className="text-xl font-semibold mb-1">{title}</h1>
      {subtitle && <p className="text-sm text-slate-400 mb-5">{subtitle}</p>}
      {children}
      {footer && <div className="mt-5 pt-4 border-t border-slate-700 text-sm text-slate-400">{footer}</div>}
    </div>
  </div>
);

export const Field = ({ label, hint, ...props }) => (
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

export const Button = ({ children, busy, ...props }) => (
  <button
    {...props}
    disabled={busy || props.disabled}
    className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50
               px-4 py-2 font-medium transition"
  >
    {busy ? "Working…" : children}
  </button>
);

export const Problem = ({ children }) =>
  children ? (
    <div role="alert" className="mb-3 rounded-lg bg-rose-950 border border-rose-800 px-3 py-2 text-sm text-rose-200">
      {children}
    </div>
  ) : null;

/**
 * Sign in or create an account.
 *
 * `chrome={false}` renders just the form, for embedding inside another card --
 * which is how the invite page uses it.
 */
export function SignIn({ onDone, allowSignup = true, chrome = true, startMode = "in", intro, inviteToken }) {
  const [mode, setMode] = useState(startMode);
  const [form, setForm] = useState({ email: "", password: "", confirm: "", displayName: "", totp: "" });
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Deliberately not remembered between renders of the form. Somebody creating
  // a second account should read it again.
  const [acceptedLoss, setAcceptedLoss] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);

    if (mode === "up") {
      if (!acceptedLoss) {
        return setError("Please confirm you understand that a forgotten password cannot be recovered.");
      }
      if (form.password.length < 12) {
        return setError(
          "Use at least 12 characters. This password is the only thing that can decrypt " +
          "your household — nobody can reset it for you."
        );
      }
      if (form.password !== form.confirm) return setError("The two passwords do not match.");
    }

    setBusy(true);
    try {
      if (mode === "up") {
        await session.register({
          email: form.email, password: form.password, displayName: form.displayName,
          // Present when signing up from an invitation, which is what lets this
          // work on a server that has closed public registration.
          inviteToken,
        });
      } else {
        await session.signIn({ email: form.email, password: form.password, totp: form.totp || undefined });
      }
      await onDone();
    } catch (err) {
      if (err.code === "totp_required") {
        setNeedsTotp(true);
        setError("Enter the code from your authenticator app.");
      } else {
        setError(err.message);
      }
      setBusy(false);
    }
  }

  const toggle = allowSignup && (
    <button type="button" className="underline hover:text-slate-200"
            onClick={() => { setMode(mode === "up" ? "in" : "up"); setError(null); }}>
      {mode === "up" ? "I already have an account" : "Create an account"}
    </button>
  );

  const form_ = (
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

      {/* The single most important thing anybody signing up needs to understand,
          and the one most likely to be skimmed. It is a blocking checkbox rather
          than a line of small print because the consequence is total and
          permanent: nobody -- not us, not whoever runs this server, not a court
          order -- can decrypt a household without a member's password. */}
      {mode === "up" && (
        <label className="flex gap-3 items-start mb-4 rounded-lg bg-amber-950/40 border border-amber-800/60 p-3">
          <input
            type="checkbox"
            checked={acceptedLoss}
            onChange={(e) => setAcceptedLoss(e.target.checked)}
            className="mt-0.5 h-4 w-4 flex-none accent-amber-500"
          />
          <span className="text-sm text-amber-100">
            <strong>I understand there is no password reset.</strong> My household is
            encrypted with a key derived from this password, and it is never sent to the
            server. If I forget it, my data cannot be recovered — not by me, not by whoever
            runs this server, not by anyone. There is no backup that would help.
            <span className="block mt-1 text-amber-200/80">
              Write it down, or use a password manager.
            </span>
          </span>
        </label>
      )}

      <Button busy={busy} disabled={mode === "up" && !acceptedLoss}>
        {mode === "up" ? "Create account" : "Sign in"}
      </Button>
      {!chrome && toggle && <div className="mt-3 text-sm text-slate-400">{toggle}</div>}
    </form>
  );

  if (!chrome) return <div>{intro}{form_}</div>;

  return (
    <Card
      title={mode === "up" ? "Create your account" : "Sign in to HouseHub"}
      subtitle={mode === "up"
        ? "Your password never leaves this device."
        : "Your household is encrypted; only your password opens it."}
      footer={toggle}
    >
      {form_}
    </Card>
  );
}
