// Links client-side API calls (fetch('/api/users'), api(`/repos/${id}`)) to the server routes that
// handle them, so the diagram can show real HTTP edges between a frontend and its backend.
import type { FileFacts } from './parse.js';

export interface HttpLink {
  /** File making the call. */
  client: string;
  clientLine: number;
  callPath: string;
  /** File declaring the route. */
  server: string;
  serverLine: number;
  method: string;
  route: string;
}

/** Split a URL path into segments, with parameters and interpolations as '*'. */
export function pathSegments(p: string): string[] {
  return p
    .split(/[?#]/)[0]
    .replace(/\$\{[^}]*\}|\{[^}]*\}/g, '*')
    .split('/')
    .filter(Boolean)
    .map((s) => (/^(?::|<|\[).*|^\*.*$/.test(s) ? '*' : s.toLowerCase()));
}

/** Does the client path hit the route? Allows up to two extra leading client segments (/api, /api/v1) for mount prefixes. */
export function pathMatches(call: string[], route: string[]): boolean {
  if (!route.length || call.length < route.length || call.length - route.length > 2) return false;
  const tail = call.slice(call.length - route.length);
  let literal = 0;
  for (let i = 0; i < route.length; i++) {
    if (route[i] === '*' || tail[i] === '*') continue;
    if (route[i] !== tail[i]) return false;
    literal++;
  }
  return literal > 0;
}

/** Every (call, route) pair that matches. For one call, only the most specific routes (most literal segments) are kept. */
export function linkHttpCalls(facts: Map<string, FileFacts>): HttpLink[] {
  const routes: { path: string; line: number; method: string; route: string; segs: string[] }[] = [];
  for (const [path, fx] of facts) {
    if (fx.isTest) continue;
    for (const r of fx.routes) if (r.method !== 'USE' && r.path.startsWith('/')) routes.push({ path, line: r.line, method: r.method, route: r.path, segs: pathSegments(r.path) });
  }
  if (!routes.length) return [];
  const links: HttpLink[] = [];
  for (const [client, fx] of facts) {
    for (const c of fx.httpCalls) {
      const segs = pathSegments(c.path);
      const hits = routes.filter((r) => r.path !== client && pathMatches(segs, r.segs));
      if (!hits.length) continue;
      const score = (r: (typeof routes)[number]) => r.segs.filter((s) => s !== '*').length * 10 + r.segs.length;
      const best = Math.max(...hits.map(score));
      for (const r of hits.filter((h) => score(h) === best)) {
        links.push({ client, clientLine: c.line, callPath: c.path, server: r.path, serverLine: r.line, method: r.method, route: r.route });
      }
    }
  }
  return links;
}
