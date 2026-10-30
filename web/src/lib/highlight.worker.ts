import { highlight } from './highlight-core';

type Request = { type: 'highlight'; id: number; code: string; lang?: string | null } | { type: 'cancel'; id: number };

// Requests are handled one at a time so a cancel can skip work that has not started yet.
const cancelled = new Set<number>();
let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<Request>) => {
  const msg = event.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  queue = queue.then(async () => {
    if (cancelled.delete(msg.id)) return;
    const html = await highlight(msg.code, msg.lang);
    if (!cancelled.delete(msg.id)) self.postMessage({ id: msg.id, html });
  });
};
