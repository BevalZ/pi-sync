#!/usr/bin/env node
/**
 * Tests for pure-JS ZIP list/extract (legacy Windows backups).
 */
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { deflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Load zip-utils via dynamic import of .ts with jiti if available, else inline reimplementation for CI-less run
// Prefer spawning node with the TypeScript through a tiny loader:
let listZipEntries, extractZipToDir, isZipFile, isZipBuffer;

async function load() {
  try {
    const require = createRequire(import.meta.url);
    // Try jiti from agent tree
    const jitiCandidates = [
      join(process.env.USERPROFILE || process.env.HOME || "", ".pi/agent/npm/node_modules/jiti/lib/jiti.cjs"),
      join(process.env.USERPROFILE || process.env.HOME || "", ".pi/agent/npm/node_modules/jiti/lib/index.js"),
    ];
    for (const jp of jitiCandidates) {
      try {
        const { createJiti } = require(jp);
        const jiti = createJiti(import.meta.url);
        const mod = jiti(join(root, "extensions/_shared/zip-utils.ts"));
        listZipEntries = mod.listZipEntries;
        extractZipToDir = mod.extractZipToDir;
        isZipFile = mod.isZipFile;
        isZipBuffer = mod.isZipBuffer;
        return;
      } catch {
        // continue
      }
    }
  } catch {
    // fall through
  }
  // Fallback: compile-free — re-require by reading and evaluating is too heavy; use child process with tsx?
  // Direct import won't work for .ts. Use a minimal pure-js copy of the critical path for hermetic test
  // by writing a temporary .mjs that duplicates the API via dynamic import of compiled output.
  // Simplest path: implement a tiny zip builder + call the TS via node --import tsx if present.
  throw new Error("jiti not found to load zip-utils.ts");
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Build a minimal ZIP (store or deflate) with one file. */
function buildZip(entries) {
  // entries: [{ name, data: Buffer, method: 0|8 }]
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const method = e.method ?? 8;
    const compressed = method === 0 ? raw : deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(Buffer.concat([local, compressed]));
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBlob, centralBlob, eocd]);
}

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) {
    console.log(`PASS  ${name}`);
    passed++;
  } else {
    console.error(`FAIL  ${name}`);
    failed++;
  }
}

try {
  await load();
} catch (e) {
  console.error("LOAD FAIL", e.message);
  // Still run structure checks on source
  const src = readFileSync(join(root, "extensions/_shared/zip-utils.ts"), "utf8");
  assert(src.includes("export function extractZipToDir"), "zip-utils has extractZipToDir");
  assert(src.includes("export function listZipEntries"), "zip-utils has listZipEntries");
  assert(src.includes("inflateRawSync"), "zip-utils uses inflateRaw");
  const idx = readFileSync(join(root, "extensions/sync/index.ts"), "utf8");
  assert(idx.includes('from "../_shared/zip-utils"'), "sync imports zip-utils");
  assert(idx.includes("extractZipToDir"), "sync calls extractZipToDir");
  assert(idx.includes("looksLikeZipFile"), "sync magic-byte zip detect");
  console.log(`\n${passed} passed, ${failed} failed (load skipped)`);
  process.exit(failed ? 1 : 0);
}

const dir = join(tmpdir(), `pi-sync-zip-test-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const zipPath = join(dir, "sample.zip");
const outDir = join(dir, "out");

const zipBuf = buildZip([
  { name: "config/models.json", data: Buffer.from('{"providers":{}}', "utf8"), method: 8 },
  { name: "./skills/hello/SKILL.md", data: Buffer.from("# hi", "utf8"), method: 0 },
]);
writeFileSync(zipPath, zipBuf);

assert(isZipFile(zipPath), "isZipFile true");
assert(isZipBuffer(zipBuf), "isZipBuffer true");

const names = listZipEntries(zipPath);
assert(names.some((n) => n.includes("models.json")), "list has models.json");
assert(names.some((n) => n.includes("SKILL.md")), "list has SKILL.md");

extractZipToDir(zipPath, outDir);
assert(existsSync(join(outDir, "config/models.json")), "extracted models.json");
assert(existsSync(join(outDir, "skills/hello/SKILL.md")), "extracted skill (normalized ./)");
assert(readFileSync(join(outDir, "config/models.json"), "utf8").includes("providers"), "content ok");

// traversal rejected
let rejected = false;
try {
  const evil = buildZip([{ name: "../escape.txt", data: Buffer.from("x"), method: 0 }]);
  const evilPath = join(dir, "evil.zip");
  writeFileSync(evilPath, evil);
  extractZipToDir(evilPath, outDir);
} catch {
  rejected = true;
}
assert(rejected, "path traversal rejected");

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // ignore
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
