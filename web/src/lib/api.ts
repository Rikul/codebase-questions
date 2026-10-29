import type { AskEvent, AskRequest } from '@cq/shared';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const authEvents = new EventTarget();

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' });
  if (res.status === 401 && !path.startsWith('/auth/')) authEvents.dispatchEvent(new Event('unauthorized'));
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

/** POST a question and stream SSE events back. */
export async function ask(repoId: string, req: AskRequest, onEvent: (ev: AskEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (res.status === 401) authEvents.dispatchEvent(new Event('unauthorized'));
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (data) onEvent(JSON.parse(data));
    }
  }
}
