import { highlight } from './highlight-core';

self.onmessage = async (event: MessageEvent<{ code: string; lang?: string | null }>) => {
  self.postMessage(await highlight(event.data.code, event.data.lang));
};
