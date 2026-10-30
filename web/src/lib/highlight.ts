/**
 * Tokenization runs off the UI thread in one long-lived worker, so shiki's highlighter and loaded
 * grammars are reused across page turns and files. Aborted requests are skipped if not yet started.
 */
let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (html: string | null) => void>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  worker.onmessage = (event: MessageEvent<{ id: number; html: string | null }>) => {
    pending.get(event.data.id)?.(event.data.html);
  };
  worker.onerror = () => {
    // A broken worker fails every outstanding request; the next call starts a fresh one.
    worker?.terminate();
    worker = null;
    for (const resolve of [...pending.values()]) resolve(null);
  };
  return worker;
}

export function highlight(code: string, lang: string | null | undefined, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const w = signal.aborted ? null : getWorker();
    if (!w) return resolve(null);
    const id = nextId++;
    const finish = (html: string | null) => {
      pending.delete(id);
      signal.removeEventListener('abort', abort);
      resolve(html);
    };
    const abort = () => {
      w.postMessage({ type: 'cancel', id });
      finish(null);
    };
    pending.set(id, finish);
    signal.addEventListener('abort', abort, { once: true });
    w.postMessage({ type: 'highlight', id, code, lang });
  });
}
