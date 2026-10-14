// A tiny external store for in-flight uploads, so progress survives moving between screens.
import { useSyncExternalStore } from 'react';
import { uploadDrawingSet, type Progress } from './uploader.ts';

export interface UploadJob {
  id: string;
  projectId: string;
  fileName: string;
  sizeBytes: number;
  phase: Progress['phase'] | 'error' | 'cancelled';
  pct: number;
  text: string;
  error?: string;
  controller: AbortController;
}

let jobs: UploadJob[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  jobs = [...jobs]; // new array identity for useSyncExternalStore
  listeners.forEach((l) => l());
};

export function startUpload(projectId: string, file: File, maxBytes: number, onDone?: () => void): UploadJob {
  const job: UploadJob = {
    id: crypto.randomUUID(), projectId, fileName: file.name, sizeBytes: file.size,
    phase: 'uploading', pct: 0, text: 'Starting…', controller: new AbortController(),
  };
  jobs = [...jobs, job];
  emit();
  uploadDrawingSet(projectId, file, {
    maxBytes,
    signal: job.controller.signal,
    onProgress: (p) => {
      Object.assign(job, p);
      emit();
    },
  })
    .then(() => {
      onDone?.();
      // Keep the finished row visible for a moment, then clear it.
      setTimeout(() => dismissUpload(job.id), 4000);
    })
    .catch((e) => {
      if (e instanceof DOMException && e.name === 'AbortError') {
        job.phase = 'cancelled';
        job.text = 'Cancelled';
        setTimeout(() => dismissUpload(job.id), 1500);
      } else {
        job.phase = 'error';
        job.error = e instanceof Error ? e.message : 'The upload failed.';
        job.text = job.error;
      }
      emit();
      onDone?.();
    });
  return job;
}

export function cancelUpload(id: string) {
  jobs.find((j) => j.id === id)?.controller.abort();
}

export function dismissUpload(id: string) {
  jobs = jobs.filter((j) => j.id !== id);
  emit();
}

export function useUploads(projectId?: string): UploadJob[] {
  const all = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => jobs,
  );
  return projectId ? all.filter((j) => j.projectId === projectId) : all;
}

export const hasActiveUploads = () => jobs.some((j) => j.phase === 'uploading' || j.phase === 'splitting');

window.addEventListener('beforeunload', (e) => {
  if (hasActiveUploads()) {
    e.preventDefault();
    e.returnValue = '';
  }
});
