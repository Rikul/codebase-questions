export interface Chunk {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * Split a file into ~`size`-line chunks, preferring to break on blank lines or
 * top-level declarations so chunks stay readable as citations.
 */
export function chunkFile(path: string, content: string, size = 120, overlap = 10): Chunk[] {
  const lines = content.split('\n');
  if (lines.length <= size + 30) return [{ path, startLine: 1, endLine: lines.length, content }];
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + size);
    if (end < lines.length) {
      // Look back up to 30 lines for a natural boundary.
      for (let i = end; i > end - 30 && i > start + 20; i--) {
        const l = lines[i] ?? '';
        if (l.trim() === '' || /^(export |def |class |func |fn |pub |public |private |async |function |@)/.test(l)) {
          end = i;
          break;
        }
      }
    }
    chunks.push({ path, startLine: start + 1, endLine: end, content: lines.slice(start, end).join('\n') });
    if (end >= lines.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
