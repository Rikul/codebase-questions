import path from 'node:path';
import { config } from './config.js';

/** Checkout directory for a repository. */
export function repoDir(repoId: string) {
  return path.join(config.reposDir, repoId);
}
