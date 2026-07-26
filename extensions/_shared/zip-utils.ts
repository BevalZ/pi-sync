/**
 * Minimal ZIP list/extract for pi-sync legacy backups.
 * No external deps — Node zlib only. Supports store (0) + deflate (8).
 *
 * Why: Windows `tar -a` creates real ZIP files; Linux GNU tar cannot extract them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// Zip-bomb defense: reject archives whose declared/actual uncompressed size is
// unreasonable for a Pi config backup. These are generous ceilings — real
// backups (config + skills + extensions) are typically a few MB.
const MAX_ENTRY_UNCOMPRESSED = 512 * 1024 * 1024; // 512 MiB per file
const MAX_TOTAL_UNCOMPRESSED = 2 * 1024 * 1024 * 1024; // 2 GiB per archive

export function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOCAL;
}

export function isZipFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const head = Buffer.alloc(4);
      const n = fs.readSync(fd, head, 0, 4, 0);
      return n === 4 && head.readUInt32LE(0) === SIG_LOCAL;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  localHeaderOffset: number;
}

function readU16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}
function readU32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

/** Find EOCD and parse central directory. */
function parseCentralDirectory(buf: Buffer): ZipEntry[] {
  // EOCD is at the end; comment max 64k so search last ~70k
  const searchFrom = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= searchFrom; i--) {
    if (readU32(buf, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    // Fallback: walk local headers (some archives omit usable EOCD in edge cases)
    return parseLocalHeaders(buf);
  }

  const cdSize = readU32(buf, eocd + 12);
  const cdOffset = readU32(buf, eocd + 16);
  if (cdOffset + cdSize > buf.length) {
    return parseLocalHeaders(buf);
  }

  const entries: ZipEntry[] = [];
  let off = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (off + 46 <= cdEnd) {
    if (readU32(buf, off) !== SIG_CENTRAL) break;
    const method = readU16(buf, off + 10);
    const compSize = readU32(buf, off + 20);
    const uncompSize = readU32(buf, off + 24);
    const nameLen = readU16(buf, off + 28);
    const extraLen = readU16(buf, off + 30);
    const commentLen = readU16(buf, off + 32);
    const localHeaderOffset = readU32(buf, off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compSize, uncompSize, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries.length > 0 ? entries : parseLocalHeaders(buf);
}

function parseLocalHeaders(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let off = 0;
  while (off + 30 <= buf.length) {
    if (readU32(buf, off) !== SIG_LOCAL) break;
    const method = readU16(buf, off + 8);
    const compSize = readU32(buf, off + 18);
    const uncompSize = readU32(buf, off + 22);
    const nameLen = readU16(buf, off + 26);
    const extraLen = readU16(buf, off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString("utf8");
    const dataStart = off + 30 + nameLen + extraLen;
    // Skip data descriptor weirdness: if sizes are 0 and bit3 set, we can't easily walk —
    // prefer central directory path. Still record entry with local offset for extract.
    entries.push({
      name,
      method,
      compSize,
      uncompSize,
      localHeaderOffset: off,
    });
    if (compSize === 0 && uncompSize === 0) {
      // Can't advance reliably without central dir
      break;
    }
    off = dataStart + compSize;
  }
  return entries;
}

function normalizeZipName(name: string): string {
  let n = name.replace(/\\/g, "/");
  while (n.startsWith("./")) n = n.slice(2);
  if (n.startsWith("/")) n = n.slice(1);
  return n;
}

function safeDestPath(destDir: string, entryName: string): string | null {
  const n = normalizeZipName(entryName);
  if (!n || n.endsWith("/")) return null; // directory marker
  if (n.includes("..") || path.isAbsolute(n) || /^[a-zA-Z]:/.test(n)) {
    throw new Error(`Unsafe zip path rejected: ${entryName}`);
  }
  const full = path.resolve(destDir, n);
  const root = path.resolve(destDir) + path.sep;
  if (full !== path.resolve(destDir) && !full.startsWith(root)) {
    throw new Error(`Zip path escapes destination: ${entryName}`);
  }
  return full;
}

function readLocalFileData(buf: Buffer, entry: ZipEntry): Buffer {
  const off = entry.localHeaderOffset;
  if (readU32(buf, off) !== SIG_LOCAL) {
    throw new Error(`Invalid local header for ${entry.name}`);
  }
  const nameLen = readU16(buf, off + 26);
  const extraLen = readU16(buf, off + 28);
  // Prefer sizes from local header if non-zero (data descriptor cases use central sizes)
  let compSize = readU32(buf, off + 18);
  let method = readU16(buf, off + 8);
  if (compSize === 0) compSize = entry.compSize;
  if (method === 0 && entry.method) method = entry.method;
  const dataStart = off + 30 + nameLen + extraLen;
  const dataEnd = dataStart + compSize;
  if (dataEnd > buf.length) {
    throw new Error(`Truncated zip data for ${entry.name}`);
  }
  const compressed = buf.subarray(dataStart, dataEnd);
  if (method === 0) {
    if (compressed.length > MAX_ENTRY_UNCOMPRESSED) {
      throw new Error(`Zip entry exceeds size limit (${entry.name})`);
    }
    return Buffer.from(compressed);
  }
  if (method === 8) {
    // Bound the inflate output to guard against zip bombs. inflateRawSync honors
    // maxOutputLength and throws RangeError (ERR_BUFFER_TOO_LARGE) when exceeded.
    try {
      return zlib.inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_UNCOMPRESSED });
    } catch (e) {
      throw new Error(`Zip entry too large or corrupt (${entry.name}): ${(e as Error).message}`);
    }
  }
  throw new Error(`Unsupported zip compression method ${method} for ${entry.name}`);
}

/** List entry paths inside a zip file (files only, normalized). */
export function listZipEntries(filePath: string): string[] {
  const buf = fs.readFileSync(filePath);
  if (!isZipBuffer(buf)) {
    throw new Error(`Not a ZIP file: ${filePath}`);
  }
  const entries = parseCentralDirectory(buf);
  const names: string[] = [];
  for (const e of entries) {
    const n = normalizeZipName(e.name);
    if (n && !n.endsWith("/")) names.push(n);
  }
  return names;
}

/** Extract zip into destDir (creates dirs as needed). */
export function extractZipToDir(filePath: string, destDir: string): void {
  const buf = fs.readFileSync(filePath);
  if (!isZipBuffer(buf)) {
    throw new Error(`Not a ZIP file: ${filePath}`);
  }
  const entries = parseCentralDirectory(buf);
  if (entries.length === 0) {
    throw new Error("ZIP archive has no entries");
  }
  // Reject up front if the central directory declares an implausible total size.
  let declaredTotal = 0;
  for (const e of entries) {
    if (e.uncompSize > MAX_ENTRY_UNCOMPRESSED) {
      throw new Error(`Zip entry declares oversized content (${e.name})`);
    }
    declaredTotal += e.uncompSize;
  }
  if (declaredTotal > MAX_TOTAL_UNCOMPRESSED) {
    throw new Error("Zip archive declares oversized total content — refusing to extract");
  }

  fs.mkdirSync(destDir, { recursive: true });
  let files = 0;
  let writtenTotal = 0;
  for (const e of entries) {
    const dest = safeDestPath(destDir, e.name);
    if (!dest) {
      // directory entry
      const dirName = normalizeZipName(e.name);
      if (dirName) {
        const d = path.resolve(destDir, dirName);
        if (d.startsWith(path.resolve(destDir) + path.sep) || d === path.resolve(destDir)) {
          fs.mkdirSync(d, { recursive: true });
        }
      }
      continue;
    }
    const data = readLocalFileData(buf, e);
    writtenTotal += data.length;
    if (writtenTotal > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error("Zip extraction exceeded total size limit — aborting");
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    files++;
  }
  if (files === 0) {
    throw new Error("ZIP archive extracted zero files");
  }
}
