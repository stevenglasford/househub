// ActionButton.jsx — one button, so every action in the app behaves the same.
//
// The complaint that produced this file was "I press it and I cannot tell if
// anything happened", and that was fair. Buttons here fired an async request and
// then looked identical for as long as it took: no busy state, no confirmation,
// and on failure an error rendered somewhere else on the page. Pressing a button
// and seeing nothing change is indistinguishable from a broken button, so people
// press it again, which is how you get two households or two invitations.
//
// The contract, everywhere:
//
//   press    -> immediately shows it is working, and refuses further presses
//   success  -> says so, briefly and in place, then settles back
//   failure  -> says why, next to the button rather than at the top of the page
//
// It takes an async `onClick` and manages the rest. A handler that throws is
// caught and shown -- an unhandled rejection would otherwise leave the button
// stuck on "Working…" forever, which is worse than the original problem.

import React, { useState, useRef, useEffect, useCallback } from "react";

const SETTLE_MS = 2200;

export default function ActionButton({
  onClick,
  children,
  theme: T,
  variant = "secondary",     // primary | secondary | danger
  busyLabel = "Working…",
  doneLabel = "Done",
  disabled = false,
  confirm = null,            // a sentence to confirm before running
  title,
  style: extra,
  onError,
  ...rest
}) {
  const [state, setState] = useState("idle");   // idle | busy | done | failed
  const [message, setMessage] = useState(null);
  const alive = useRef(true);
  const timer = useRef(null);

  useEffect(() => () => {
    // A component unmounted mid-request must not try to set state afterwards.
    alive.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const run = useCallback(async (event) => {
    if (state === "busy" || disabled) return;
    if (confirm && !window.confirm(confirm)) return;

    setState("busy");
    setMessage(null);
    try {
      await onClick?.(event);
      if (!alive.current) return;
      setState("done");
      timer.current = setTimeout(() => { if (alive.current) setState("idle"); }, SETTLE_MS);
    } catch (err) {
      if (!alive.current) return;
      setState("failed");
      setMessage(err?.message || "That did not work");
      onError?.(err);
    }
  }, [onClick, state, disabled, confirm, onError]);

  const palette = {
    primary:   { bg: T?.brand || "#2E9187", fg: "#fff", border: T?.brand || "#2E9187" },
    secondary: { bg: T?.panel || "#fff", fg: T?.ink || "#222", border: T?.line || "#ddd" },
    danger:    { bg: "#B4442A", fg: "#fff", border: "#B4442A" },
  }[variant] || {};

  const isBusy = state === "busy";
  const isDone = state === "done";

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <button
        {...rest}
        type="button"
        onClick={run}
        disabled={disabled || isBusy}
        aria-busy={isBusy}
        aria-live="polite"
        title={title}
        style={{
          background: isDone ? "#1f7a4d" : palette.bg,
          color: isDone ? "#fff" : palette.fg,
          border: `1px solid ${isDone ? "#1f7a4d" : palette.border}`,
          borderRadius: 10,
          padding: "9px 15px",
          fontWeight: 600,
          cursor: disabled || isBusy ? "default" : "pointer",
          opacity: disabled ? 0.5 : 1,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          transition: "background .15s ease, color .15s ease, opacity .15s ease",
          ...extra,
        }}
      >
        {isBusy && <Spinner />}
        {isDone && <span aria-hidden="true">✓</span>}
        <span>{isBusy ? busyLabel : isDone ? doneLabel : children}</span>
      </button>

      {/* Beside the button, not at the top of the panel. A failure announced
          above the fold of a scrolled page reads as nothing having happened. */}
      {state === "failed" && message && (
        <span role="alert" style={{ color: "#B4442A", fontSize: 12.5, maxWidth: 320 }}>
          {message}
        </span>
      )}
    </span>
  );
}

/** A spinner that respects a reduced-motion preference. */
function Spinner() {
  return (
    <>
      <style>{`
        @keyframes hubspin { to { transform: rotate(360deg) } }
        @media (prefers-reduced-motion: reduce) { .hubspin { animation: none !important } }
      `}</style>
      <span
        className="hubspin"
        aria-hidden="true"
        style={{
          width: 13, height: 13, borderRadius: "50%",
          border: "2px solid currentColor", borderTopColor: "transparent",
          display: "inline-block", animation: "hubspin .7s linear infinite",
        }}
      />
    </>
  );
}
