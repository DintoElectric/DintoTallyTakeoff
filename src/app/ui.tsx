import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CaretRight, Check as CheckIcon, Hash } from '@phosphor-icons/react';
import type { MarkerShape } from '../../shared/types.ts';
import { APP_NAME } from '../../shared/limits.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { navigate, paths, type Route } from './router.ts';

/* ---------- toast ---------- */
const ToastCtx = createContext<(msg: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>();
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  );
}

/* ---------- top bar ---------- */
export type Crumb = { label: string; to?: string };

function initials(name: string, email: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && name !== email) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  const base = (name !== email ? name : email.split('@')[0]) || '?';
  return base.slice(0, 2).toUpperCase();
}

function AvatarMenu() {
  const { me, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', on);
    return () => window.removeEventListener('pointerdown', on);
  }, [open]);
  if (!me) return null;
  return (
    <div ref={ref}>
      <button className="avatar" onClick={() => setOpen(!open)} aria-label="Account menu" aria-expanded={open}>{initials(me.name, me.email)}</button>
      {open && (
        <div className="menu" role="menu">
          <div style={{ fontWeight: 500 }}>{me.name}</div>
          <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{me.email}</div>
          <div className="muted" style={{ marginBottom: 10 }}>Role: {me.role}</div>
          <button className="btn btn-secondary btn-block" style={{ marginTop: 0 }} onClick={() => signOut()}>Sign out</button>
        </div>
      )}
    </div>
  );
}

export function TopBar({ crumbs, nav, children }: { crumbs?: Crumb[]; nav?: Route['name']; children?: ReactNode }) {
  return (
    <header className="topbar">
      <button className="brand" onClick={() => navigate(paths.projects())} aria-label={`${APP_NAME} home`}>
        <span className="brand-mark"><Hash size={12} /></span>
        {APP_NAME}
      </button>
      {crumbs ? (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: 'contents' }}>
              {i > 0 && <CaretRight size={11} />}
              {c.to && i < crumbs.length - 1 ? <button onClick={() => navigate(c.to!)}>{c.label}</button> : <span className="last">{c.label}</span>}
            </span>
          ))}
        </nav>
      ) : (
        <nav className="navlinks">
          <button aria-current={nav === 'projects' ? 'page' : undefined} onClick={() => navigate(paths.projects())}>Projects</button>
        </nav>
      )}
      <div className="topbar-right">
        {children}
        <AvatarMenu />
      </div>
    </header>
  );
}

/* ---------- small controls ---------- */
export function Check({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className={`check${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="box"><CheckIcon size={11} weight="bold" /></span>
      {children}
    </label>
  );
}

export function Seg<T extends string>({ value, onChange, options, name }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; name: string }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <label key={o.value} className="seg-opt">
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** Symbol tile: marker shape + 1-2 letter glyph, exactly as drawn on the sheet (Part 1). */
export function Symbol({ shape, glyph, active, big }: { shape: MarkerShape; glyph: string | null; active?: boolean; big?: boolean }) {
  return (
    <div className={`sym${active ? ' active' : ''}${big ? ' big' : ''}`} aria-hidden="true">
      <span className={shape}><b>{glyph ?? ''}</b></span>
    </div>
  );
}

export function Dialog({ title, onClose, children, wide, className }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" style={{ zIndex: 50 }} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        {children}
      </div>
    </div>
  );
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const fmtBytes = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
