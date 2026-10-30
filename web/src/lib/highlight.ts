/** Tokenization runs off the UI thread; aborted viewers terminate their work. */
export function highlight(code: string, lang: string | null | undefined, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    if (signal.aborted || typeof Worker === 'undefined') return resolve(null);
    let worker: Worker;
    try {
      worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return resolve(null);
    }
    const finish = (html: string | null) => {
      signal.removeEventListener('abort', abort);
      worker.terminate();
      resolve(html);
    };
    const abort = () => finish(null);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<string | null>) => finish(event.data);
    worker.onerror = () => finish(null);
    worker.postMessage({ code, lang });
  });
}
