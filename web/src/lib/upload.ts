import ignore from 'ignore';
import { DEFAULT_IGNORES } from '@cq/shared';
import { authEvents } from './api';

export interface UploadCreated {
  repoId: string;
  jobId: string;
  files: number;
  warnings: string[];
}

/**
 * Pick the files of a chosen folder worth sending: drops what the server would never analyze
 * (node_modules, .git, build output, binaries, lock files) and whatever the folder's root
 * .gitignore excludes, so large dependency folders are never uploaded.
 */
export async function folderFiles(list: FileList): Promise<{ files: File[]; paths: string[]; skipped: number }> {
  const all = [...list].map((f) => ({ f, rel: (f.webkitRelativePath || f.name).replace(/\\/g, '/') }));
  const top = all[0]?.rel.split('/')[0] ?? '';
  const inner = (rel: string) => (top && rel.startsWith(`${top}/`) ? rel.slice(top.length + 1) : rel);
  const ig = ignore().add(DEFAULT_IGNORES).add(['.DS_Store']);
  const gitignore = all.find((x) => inner(x.rel) === '.gitignore');
  if (gitignore) ig.add(await gitignore.f.text());
  const kept = all.filter((x) => {
    const rel = inner(x.rel);
    return rel && !ig.ignores(rel);
  });
  return { files: kept.map((x) => x.f), paths: kept.map((x) => x.rel), skipped: all.length - kept.length };
}

/** POST a FormData to /api/repos/upload, reporting upload progress (0..1). */
export function uploadSource(fd: FormData, onProgress: (fraction: number) => void): Promise<UploadCreated> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/repos/upload');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new Error('Upload failed (network error).'));
    xhr.onload = () => {
      if (xhr.status === 401) authEvents.dispatchEvent(new Event('unauthorized'));
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body as UploadCreated);
      else reject(new Error(body?.error ?? `Upload failed (${xhr.status} ${xhr.statusText})`));
    };
    xhr.send(fd);
  });
}
