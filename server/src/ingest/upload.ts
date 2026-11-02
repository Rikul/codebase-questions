import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { isIgnoredPath } from './scan.js';

// Turns an uploaded ZIP archive or browser folder upload into a source tree under `dest`.
// Nothing from the upload is executed. Entry paths are validated so nothing is written outside
// `dest`; symlinks are skipped; `.git` directories are dropped (their config can make git run
// commands), so uploads have no history; paths the scanner ignores are not written at all.

const inflateRaw = promisify(zlib.inflateRaw);

export interface UploadLimits {
  /** Total bytes of files written. */
  maxBytes: number;
  maxFiles: number;
  /** Larger files are skipped (the scanner would skip them anyway). */
  maxFileBytes: number;
}

export interface UploadResult {
  files: number;
  bytes: number;
  /** The single top-level folder that was stripped (e.g. `repo-main` from a GitHub ZIP), if any. */
  root: string | null;
  warnings: string[];
}

export interface UploadEntry {
  path: string;
  size: number;
  read: () => Promise<Buffer>;
}

/** Normalize an entry path to a relative posix path, or null if it is unsafe or not wanted. */
export function cleanEntryPath(raw: string): string | null {
  if (raw.includes('\0')) return null;
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split('/').filter((s) => s && s !== '.');
  if (!parts.length || parts.includes('..')) return null;
  if (parts.some((s) => s === '.git' || s === '__MACOSX') || parts.at(-1) === '.DS_Store') return null;
  return parts.join('/');
}

/** Write validated entries under `dest` (which must not exist yet). */
export async function writeEntries(entries: UploadEntry[], dest: string, limits: UploadLimits, warnings: string[] = []): Promise<UploadResult> {
  const cleaned = entries.flatMap((e) => {
    const rel = cleanEntryPath(e.path);
    return rel ? [{ ...e, rel }] : [];
  });
  const skippedUnsafe = entries.length - cleaned.length;
  // Strip one shared top-level folder (`repo-main/` in a GitHub ZIP, the folder name in a folder upload).
  const first = cleaned[0]?.rel.split('/')[0];
  const root = first && cleaned.length && cleaned.every((e) => e.rel.startsWith(`${first}/`)) ? first : null;
  const kept = cleaned
    .map((e) => ({ ...e, rel: root ? e.rel.slice(root.length + 1) : e.rel }))
    .filter((e) => !isIgnoredPath(e.rel));
  const big = kept.filter((e) => e.size > limits.maxFileBytes);
  const files = kept.filter((e) => e.size <= limits.maxFileBytes);
  if (!files.length) throw new Error('The upload contains no source files to analyze.');
  if (files.length > limits.maxFiles) throw new Error(`The upload has ${files.length} files to analyze, over the limit of ${limits.maxFiles} (MAX_REPO_FILES).`);
  const total = files.reduce((n, e) => n + e.size, 0);
  if (total > limits.maxBytes) throw new Error(`The upload is ${(total / 1024 / 1024).toFixed(0)} MB of source, over the limit of ${(limits.maxBytes / 1024 / 1024).toFixed(0)} MB (MAX_REPO_MB).`);

  const base = path.resolve(dest);
  fs.mkdirSync(base, { recursive: true });
  let written = 0;
  let bytes = 0;
  let failed = 0;
  for (const e of files) {
    const target = path.resolve(base, e.rel);
    if (!target.startsWith(base + path.sep)) continue;
    try {
      const data = await e.read();
      if (data.length > limits.maxFileBytes) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // 'wx' refuses to follow or replace anything already there; no executable bits.
      fs.writeFileSync(target, data, { flag: 'wx', mode: 0o644 });
      written++;
      bytes += data.length;
    } catch {
      failed++;
    }
  }
  if (skippedUnsafe) warnings.push(`Skipped ${skippedUnsafe} entr${skippedUnsafe === 1 ? 'y' : 'ies'} (.git, unsafe paths or OS metadata).`);
  if (big.length) warnings.push(`Skipped ${big.length} file(s) over MAX_FILE_BYTES.`);
  if (failed) warnings.push(`Could not write ${failed} file(s) (duplicate or conflicting paths, or unreadable data).`);
  if (!written) throw new Error('None of the uploaded files could be read.');
  return { files: written, bytes, root, warnings };
}

// ---------- ZIP reading (central directory; stored and deflate entries) ----------

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/** List the entries of a ZIP archive held in memory. Throws for archives that are not ZIP, ZIP64 or split. */
export function zipEntries(buf: Buffer, warnings: string[] = []): UploadEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (or it is truncated).');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt16LE(eocd + 4) !== 0) throw new Error('Split ZIP archives are not supported.');
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error('ZIP64 archives are not supported; use a smaller archive or upload the folder.');
  if (cdOffset + cdSize > eocd) throw new Error('The ZIP file is corrupt (bad central directory).');

  const out: UploadEntry[] = [];
  let encrypted = 0;
  let unsupported = 0;
  let symlinks = 0;
  let pos = cdOffset;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CEN) throw new Error('The ZIP file is corrupt (bad entry header).');
    const madeBy = buf.readUInt16LE(pos + 4) >> 8;
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const attrs = buf.readUInt32LE(pos + 38);
    const local = buf.readUInt32LE(pos + 42);
    const nameBuf = buf.subarray(pos + 46, pos + 46 + nameLen);
    const name = nameBuf.toString(flags & 0x800 ? 'utf8' : 'latin1');
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory
    if (compSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new Error('ZIP64 archives are not supported; use a smaller archive or upload the folder.');
    // Unix symlinks (made on Unix, S_IFLNK in the high attribute bits) are skipped.
    if (madeBy === 3 && ((attrs >>> 16) & 0o170000) === 0o120000) {
      symlinks++;
      continue;
    }
    if (flags & 1) {
      encrypted++;
      continue;
    }
    if (method !== 0 && method !== 8) {
      unsupported++;
      continue;
    }
    out.push({
      path: name,
      size,
      read: async () => {
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOC) throw new Error('bad local header');
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + compSize);
        if (data.length !== compSize) throw new Error('truncated entry');
        if (method === 0) return Buffer.from(data);
        if (size === 0) return Buffer.alloc(0);
        // Cap the output at the declared size so a lying header cannot inflate past the limits.
        const res = await inflateRaw(data, { maxOutputLength: size });
        if (res.length !== size) throw new Error('size mismatch');
        return res;
      },
    });
  }
  if (symlinks) warnings.push(`Skipped ${symlinks} symlink(s).`);
  if (encrypted) warnings.push(`Skipped ${encrypted} encrypted file(s).`);
  if (unsupported) warnings.push(`Skipped ${unsupported} file(s) using an unsupported compression method.`);
  return out;
}

export async function extractZip(buf: Buffer, dest: string, limits: UploadLimits): Promise<UploadResult> {
  const warnings: string[] = [];
  return writeEntries(zipEntries(buf, warnings), dest, limits, warnings);
}
