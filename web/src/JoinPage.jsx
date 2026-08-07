// JoinPage.jsx — accepting an invitation.
//
// The old version had two bugs that between them made an invitation nearly
// unusable:
//
//   - somebody signed out was told "sign in, then open this link again", which
//     throws away the token they were sent
//   - "Go to HouseHub" was href="/", the domain root, so on an install mounted
//     at /beta it walked out of the app entirely
//
// The token is now held while the person signs in or registers inline, and the
// acceptance continues automatically afterwards. Every link goes through
// lib/paths so it stays inside the mount point.

import React, { useState, useEffect, useCallback, useRef } from "react";
import * as session from "./lib/session.js";
import { appPath, clearFragment } from "./lib/paths.js";
import { Card, Button, Problem, SignIn } from "./components/auth-ui.jsx";

export default function JoinPage() {
  // Read the token once, then strip it from the address bar. Kept in state, so
  // signing in below does not lose it.
  const [token] = useState(() => {
    const t = window.location.hash.slice(1);
    if (t) clearFragment();
    return t;
  });

  const [stage, setStage] = useState(token ? "checking" : "missing");
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [signedIn, setSignedIn] = useState(() => session.snapshot().signedIn);
  const accepting = useRef(false);

  /* Look at the invitation. Works signed out, and deliberately reveals nothing
     identifying about the household -- a leaked link should not tell a stranger
     whose home it belongs to. */
  useEffect(() => {
    if (!token) return;
    session.request("POST", "api/invites/inspect", { token })
      .then((inv) => { setInvite(inv); setStage("ready"); })
      .catch((err) => { setError(err.message); setStage("error"); });
  }, [token]);

  const accept = useCallback(async () => {
    if (accepting.current) return;
    accepting.current = true;
    setStage("working");
    try {
      const res = await session.request("POST", "api/invites/accept", { token });
      setInvite((prev) => ({ ...prev, ...res }));
      setStage("pending");
    } catch (err) {
      setError(err.message);
      setStage("error");
    } finally {
      accepting.current = false;
    }
  }, [token]);

  // Signing in from inside this page continues the join rather than ending it.
  const afterAuth = useCallback(async () => {
    setSignedIn(true);
    await accept();
  }, [accept]);

  if (stage === "missing") {
    return (
      <Card title="This link is incomplete">
        <p className="text-sm text-slate-400">
          The invitation code is missing. It may have been cut short when the message was
          forwarded — ask for a fresh link.
        </p>
        <a href={appPath()} className="block mt-4 text-sm underline text-slate-400">Go to HouseHub</a>
      </Card>
    );
  }

  if (stage === "checking") return <Card title="Checking the invitation…" />;
  if (stage === "working") return <Card title="Joining…" />;

  if (stage === "error") {
    return (
      <Card title="That did not work">
        <Problem>{error}</Problem>
        <a href={appPath()} className="block mt-4 text-sm underline text-slate-400">Go to HouseHub</a>
      </Card>
    );
  }

  if (stage === "pending") {
    return (
      <Card title="Almost there">
        <p className="text-sm text-slate-400">
          An admin needs to approve you before you can see anything. They will be shown a
          fingerprint of your key — if you can, read it back to them in person. That is what
          stops anyone in the middle substituting their own key.
        </p>
        <div className="mt-4">
          <Button onClick={() => { window.location.href = appPath(); }}>Go to HouseHub</Button>
        </div>
      </Card>
    );
  }

  /* stage === "ready" */
  if (!signedIn) {
    return (
      <Card title="You have been invited">
        <SignIn
          chrome={false}
          startMode="up"
          onDone={afterAuth}
          inviteToken={token}
          intro={
            <p className="text-sm text-slate-400 mb-5">
              You would join as <strong className="text-slate-200">{invite.role}</strong>.
              Create an account (or sign in) and you will be added straight away —
              you will not need this link again.
            </p>
          }
        />
      </Card>
    );
  }

  return (
    <Card title="You have been invited">
      <p className="text-sm text-slate-400 mb-5">
        You would join as <strong className="text-slate-200">{invite.role}</strong>.
        Nothing about the household is shown until an admin grants you a key.
      </p>
      <Button onClick={accept}>Accept invitation</Button>
    </Card>
  );
}
