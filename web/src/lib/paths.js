// paths.js — where "the app" lives, when it is not at the domain root.
//
// HouseHub is routinely mounted under a prefix (https://home.example.com/beta).
// Every asset and API call already handles that, because they are relative. Link
// targets do not: `href="/"` means the domain root, so it walks straight out of
// the install and into whatever else is on that hostname.
//
// That was a real bug: an invited person who finished the join flow was sent to
// https://example.com instead of https://example.com/hub, landing on whatever
// else shares that hostname. These helpers derive the mount point from the
// current URL so links stay inside it.

const ROUTES = ["/join", "/display"];

/**
 * The app's root path, always with a trailing slash.
 *
 * Derived from the current location rather than from /api/config, so it is
 * correct before any network request completes -- and still correct if the
 * config call fails.
 */
export function appRoot() {
  let path = window.location.pathname;
  for (const route of ROUTES) {
    if (path === route || path.endsWith(route)) {
      path = path.slice(0, -route.length);
      break;
    }
  }
  path = path.replace(/\/+$/, "");
  return path ? `${path}/` : "/";
}

/** A URL for a path inside the app. `appPath("join")` -> "/beta/join". */
export const appPath = (sub = "") => appRoot() + String(sub).replace(/^\/+/, "");

/** Navigate within the app, preserving the mount point. */
export function goTo(sub = "") {
  window.location.href = appPath(sub);
}

/**
 * Strip a secret out of the address bar without reloading.
 *
 * Invite tokens and display keys arrive in the URL fragment. Fragments are never
 * sent to the server, but they do sit in the address bar, in the back/forward
 * history, and in whatever the browser syncs between devices. Once read, remove.
 */
export function clearFragment() {
  history.replaceState(null, "", window.location.pathname + window.location.search);
}
