import { useEffect, useState } from 'react';

export type Route =
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'sheet'; id: string; sheetId: string }
  | { name: 'library'; id: string }
  | { name: 'panels'; id: string; panelId: string | null };

export function parse(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  let m = p.match(/^\/p\/([^/]+)\/s\/([^/]+)$/);
  if (m) return { name: 'sheet', id: m[1], sheetId: m[2] };
  m = p.match(/^\/p\/([^/]+)\/panels(?:\/([^/]+))?$/);
  if (m) return { name: 'panels', id: m[1], panelId: m[2] ?? null };
  m = p.match(/^\/p\/([^/]+)\/library$/);
  if (m) return { name: 'library', id: m[1] };
  m = p.match(/^\/p\/([^/]+)$/);
  if (m) return { name: 'project', id: m[1] };
  return { name: 'projects' };
}

export const paths = {
  projects: () => '/',
  project: (id: string) => `/p/${id}`,
  sheet: (id: string, sheetId: string) => `/p/${id}/s/${sheetId}`,
  library: (id: string) => `/p/${id}/library`,
  panels: (id: string, panelId?: string | null) => (panelId ? `/p/${id}/panels/${panelId}` : `/p/${id}/panels`),
};

const listeners = new Set<() => void>();
export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  listeners.forEach((l) => l());
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(location.pathname));
  useEffect(() => {
    const on = () => setRoute(parse(location.pathname));
    listeners.add(on);
    window.addEventListener('popstate', on);
    return () => {
      listeners.delete(on);
      window.removeEventListener('popstate', on);
    };
  }, []);
  return route;
}
