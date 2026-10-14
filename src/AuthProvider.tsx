import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  acceptInvite,
  getUser,
  handleAuthCallback,
  login,
  logout,
  onAuthChange,
  requestPasswordRecovery,
  updateUser,
} from '@netlify/identity';
import type { Me } from '../../shared/types.ts';
import { ApiError, api, setUnauthorizedHandler } from './api.ts';

type Phase = 'loading' | 'signed-out' | 'signed-in' | 'invite' | 'recovery';

interface AuthCtx {
  phase: Phase;
  me: Me | null; // last known user, kept after a session ends so unsaved work can survive re-login
  sessionEnded: boolean;
  error: string | null;
  busy: boolean;
  notice: string | null;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  forgot(email: string): Promise<void>;
  finishInvite(password: string): Promise<void>;
  finishRecovery(password: string): Promise<void>;
  clearMessages(): void;
}

const Ctx = createContext<AuthCtx | null>(null);
export const useAuth = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used inside AuthProvider');
  return c;
};

/** Plain words for the errors people actually hit (spec 2.5). */
function plainAuthError(e: unknown): string {
  const msg = e instanceof Error ? e.message.toLowerCase() : '';
  const status = (e as { status?: number } | null)?.status;
  if (msg.includes('confirm') || msg.includes('not confirmed')) {
    return "Your account isn't confirmed yet. Check your invite email.";
  }
  if (status === 400 || status === 401 || status === 403 || msg.includes('invalid') || msg.includes('credentials')) {
    return "That email or password isn't right.";
  }
  if (e instanceof ApiError && e.status === 0) return e.message;
  if (msg.includes('network') || msg.includes('fetch') || status === 0 || status === undefined) {
    return "Can't reach the server. Check your connection and try again.";
  }
  return 'Something went wrong. Please try again.';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inviteToken = useRef<string | null>(null);
  const hadSession = useRef(false);

  const loadMe = useCallback(async () => {
    const m = await api<Me>('/me');
    setMe(m);
    hadSession.current = true;
    setSessionEnded(false);
    setPhase('signed-in');
  }, []);

  // Boot: process invite / recovery / confirmation links, then restore any existing session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cb = await handleAuthCallback().catch((e) => {
          if (!cancelled) setError("That link didn't work. It may have expired. Ask an admin to send a new invite.");
          console.warn(e);
          return null;
        });
        if (cb?.type === 'invite' && cb.token) {
          inviteToken.current = cb.token;
          if (!cancelled) setPhase('invite');
          return;
        }
        if (cb?.type === 'recovery') {
          if (!cancelled) setPhase('recovery');
          return;
        }
        const user = await getUser();
        if (cancelled) return;
        if (user) await loadMe();
        else setPhase('signed-out');
      } catch {
        if (!cancelled) setPhase('signed-out');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe]);

  // A 401 anywhere means the session ended: show the gate over the app, keep the app mounted.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (hadSession.current) {
        setSessionEnded(true);
        setPhase('signed-out');
      }
    });
    const off = onAuthChange((event) => {
      if (event === 'logout') {
        setPhase('signed-out');
      }
    });
    return () => {
      setUnauthorizedHandler(null);
      off();
    };
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      setBusy(true);
      setError(null);
      try {
        await login(email.trim(), password); // no page reload
        await loadMe();
      } catch (e) {
        setError(plainAuthError(e));
      } finally {
        setBusy(false);
      }
    },
    [loadMe],
  );

  const signOut = useCallback(async () => {
    try {
      await logout();
    } catch {
      /* cookies are cleared even when the call fails */
    }
    hadSession.current = false;
    setMe(null);
    setSessionEnded(false);
    setPhase('signed-out');
  }, []);

  const forgot = useCallback(async (email: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestPasswordRecovery(email.trim());
      setNotice('If that email has an account, a reset link is on its way.');
    } catch (e) {
      setError(plainAuthError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const finishInvite = useCallback(
    async (password: string) => {
      setBusy(true);
      setError(null);
      try {
        if (!inviteToken.current) throw new Error('missing token');
        await acceptInvite(inviteToken.current, password);
        inviteToken.current = null;
        await loadMe();
      } catch {
        setError("We couldn't finish setting up your account. The invite may have expired. Ask an admin to send a new one.");
      } finally {
        setBusy(false);
      }
    },
    [loadMe],
  );

  const finishRecovery = useCallback(
    async (password: string) => {
      setBusy(true);
      setError(null);
      try {
        await updateUser({ password });
        await loadMe();
      } catch {
        setError("We couldn't save your new password. The reset link may have expired. Request a new one.");
      } finally {
        setBusy(false);
      }
    },
    [loadMe],
  );

  const value = useMemo<AuthCtx>(
    () => ({ phase, me, sessionEnded, error, busy, notice, signIn, signOut, forgot, finishInvite, finishRecovery, clearMessages: () => { setError(null); setNotice(null); } }),
    [phase, me, sessionEnded, error, busy, notice, signIn, signOut, forgot, finishInvite, finishRecovery],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
