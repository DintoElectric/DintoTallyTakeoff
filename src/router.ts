import { useEffect, useState } from 'react';

export type Route =
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'sheet'; id: string; sheetId: string }
  | { name: 'library' };

export function parse(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  let m = p.match(/^\/p\/([^/]+)\/s\/([^/]+)$/);
  if (m) return { name: 'sheet', id: m[1], sheetId: m[2] };
  m = p.match(/^\/p\/([^/]+)$/);
  if (m) return { name: 'project', id: m[1] };
  if (p === '/library') return { name: 'library' };
  return { name: 'projects' };
}

export const paths = {
  projects: () => '/',
  project: (id: string) => `/p/${id}`,
  sheet: (id: string, sheetId: string) => `/p/${id}/s/${sheetId}`,
  library: () => '/library',
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
