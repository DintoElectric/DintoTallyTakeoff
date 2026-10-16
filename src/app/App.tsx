import { useEffect } from 'react';
import { AuthProvider, useAuth } from '../auth/AuthProvider.tsx';
import { Gate } from '../auth/Gate.tsx';
import { ToastProvider } from './ui.tsx';
import { useRoute } from './router.ts';
import { clearPdfCache } from '../viewer/pdf.ts';
import Projects from '../screens/Projects.tsx';
import DrawingSet from '../screens/DrawingSet.tsx';
import Workspace from '../screens/Workspace.tsx';
import Library from '../screens/Library.tsx';

function Routes() {
  const route = useRoute();
  switch (route.name) {
    case 'projects': return <Projects />;
    case 'project': return <DrawingSet key={route.id} projectId={route.id} />;
    case 'sheet': return <Workspace key={route.id} projectId={route.id} sheetId={route.sheetId} />;
    case 'library': return <Library key={route.id} projectId={route.id} />;
  }
}

function Shell() {
  const a = useAuth();
  // Sign-out clears in-memory drawings too (spec 2.18).
  useEffect(() => { if (!a.me) clearPdfCache(); }, [a.me]);
  if (a.phase === 'loading') return <div className="gate"><span className="spinner" /></div>;
  if (a.phase === 'invite' || a.phase === 'recovery') return <Gate />;
  if (a.phase === 'signed-out' && !(a.sessionEnded && a.me)) return <Gate />;
  return (
    <>
      <div className="app"><Routes /></div>
      {/* Session ended mid-work: gate over the app, which stays mounted so unsaved edits survive. */}
      {a.phase === 'signed-out' && a.sessionEnded && <Gate overlay />}
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </AuthProvider>
  );
}
