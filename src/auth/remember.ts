// "Remember me": keep the sign-in for 30 days instead of until the browser closes.
//
// Netlify Identity keeps the session in two cookies, nf_jwt (the access token) and nf_refresh (the refresh token), set
// with no expiry, so the browser drops them when it closes. At start-up the Identity library then finds its saved
// session without the cookie and discards it: everyone signs in again after every restart. When the person ticks
// Remember me, the same two cookies are re-written to last REMEMBER_DAYS, and re-written again each time the token is
// renewed (so the 30 days restart whenever the app is used).

export const REMEMBER_DAYS = 30;
const KEY = 'tally.remember';
const COOKIES = ['nf_jwt', 'nf_refresh'] as const;

type Doc = { cookie: string };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const store = (): Store | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

export function isRemembered(s: Store | null = store()): boolean {
  try { return s?.getItem(KEY) === '1'; } catch { return false; }
}
export function setRemembered(on: boolean, s: Store | null = store()): void {
  try { if (on) s?.setItem(KEY, '1'); else s?.removeItem(KEY); } catch { /* private mode: the session simply ends with the browser */ }
}

/** A cookie's raw (still encoded) value, or null. */
export function rawCookie(name: string, doc: Doc): string | null {
  const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(doc.cookie);
  return m ? m[1] : null;
}

/** When remembered, re-writes the sign-in cookies to last REMEMBER_DAYS (same path and flags the Identity library uses). */
export function keepSignInCookies(doc: Doc | null = typeof document === 'undefined' ? null : document, s: Store | null = store()): number {
  if (!doc || !isRemembered(s)) return 0;
  let n = 0;
  for (const name of COOKIES) {
    const v = rawCookie(name, doc);
    if (!v) continue;
    doc.cookie = `${name}=${v}; path=/; secure; samesite=lax; max-age=${REMEMBER_DAYS * 86400}`;
    n++;
  }
  return n;
}
