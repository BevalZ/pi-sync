#!/usr/bin/env node
/**
 * Unit tests for pi-sync pure logic (config migration, archive validation,
 * backup sorting/pruning, secret resolution, profile-line matching).
 *
 * Loads the TypeScript extension module via jiti, stubbing @earendil-works/pi-tui
 * (only enhanced-select.ts needs it, and none of the tested functions call it).
 *
 * Run: node scripts/core-test.mjs
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.error(`FAIL  ${name}`);
  }
}
function throws(name, fn) {
  try {
    fn();
    fail++;
    console.error(`FAIL  ${name} (expected throw)`);
  } catch {
    pass++;
    console.log(`PASS  ${name}`);
  }
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b));
}

function loadModule() {
  const jitiCandidates = [
    join(process.env.USERPROFILE || process.env.HOME || "", ".pi/agent/npm/node_modules/jiti/lib/jiti.cjs"),
    join(root, "node_modules/jiti/lib/jiti.cjs"),
  ];
  for (const jp of jitiCandidates) {
    try {
      const { createJiti } = require(jp);
      const jiti = createJiti(fileURLToPath(import.meta.url), {
        alias: { "@earendil-works/pi-tui": join(__dirname, "stub-pi-tui.mjs") },
        interopDefault: true,
      });
      return jiti(join(root, "extensions/sync/index.ts"));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Could not load index.ts via jiti: ${lastErr?.message || "no jiti"}`);
}
let lastErr;

const mod = loadModule();
const {
  backupSortKey,
  sortBackupNamesNewestFirst,
  normalizePrefix,
  sanitizeProfileId,
  normalizeConfig,
  isLegacyFlatConfig,
  resolveSecret,
  matchProfileIdFromLine,
  selectBackupsToPrune,
  pruneTimestampedBackups,
  validateArchiveEntries,
  normalizeArchiveEntry,
  DEFAULT_BACKUP_RETENTION,
} = mod;

// ── backupSortKey / sorting ─────────────────────────────────────────────
eq(
  "backupSortKey extracts 14-digit ts",
  backupSortKey("pi_sync_backup_2026-07-04_20260704123045_windows11.tar.gz"),
  "20260704123045",
);
eq(
  "backupSortKey pads legacy date",
  backupSortKey("pi_sync_backup_2026-7-4.zip"),
  "20260704000000",
);
{
  const sorted = sortBackupNamesNewestFirst([
    "pi_sync_backup_2026-07-04_20260704010000_linux.tar.gz",
    "pi_sync_backup_2026-07-04_20260704230000_linux.tar.gz",
    "pi_sync_backup_2026-07-03_20260703120000_linux.tar.gz",
  ]);
  ok("sortBackupNamesNewestFirst newest-first", sorted[0].includes("20260704230000") && sorted[2].includes("20260703120000"));
}

// ── normalizePrefix ─────────────────────────────────────────────────────
eq("normalizePrefix adds trailing slash", normalizePrefix("pi-backups"), "pi-backups/");
eq("normalizePrefix strips leading slash", normalizePrefix("/foo/bar"), "foo/bar/");
eq("normalizePrefix empty stays empty", normalizePrefix(""), "");
eq("normalizePrefix backslashes", normalizePrefix("a\\b"), "a/b/");

// ── sanitizeProfileId ───────────────────────────────────────────────────
eq("sanitizeProfileId lowercases + dashes", sanitizeProfileId("My Prof!"), "my-prof");
eq("sanitizeProfileId empty → default", sanitizeProfileId("   "), "default");
eq("sanitizeProfileId keeps ._-", sanitizeProfileId("a.b_c-d"), "a.b_c-d");

// ── normalizeConfig / migration ─────────────────────────────────────────
{
  const c = normalizeConfig({ webdavUrl: "https://dav/" }, "p1");
  eq("normalizeConfig infers webdav backend", c.backend, "webdav");
  eq("normalizeConfig default region", c.s3Region, "us-east-1");
  eq("normalizeConfig backup flags default true", [c.backupProviders, c.backupSkills, c.backupExtensions], [true, true, true]);
}
{
  const c = normalizeConfig({ s3Bucket: "b" });
  eq("normalizeConfig infers s3 from bucket", c.backend, "s3");
  eq("normalizeConfig s3Endpoint empty → path-style off", c.s3ForcePathStyle, false);
}
{
  const c = normalizeConfig({ s3Bucket: "b", s3Endpoint: "https://minio.local" });
  eq("normalizeConfig custom endpoint → path-style on", c.s3ForcePathStyle, true);
}
{
  const c = normalizeConfig({ backupSkills: false });
  eq("normalizeConfig honors explicit false", c.backupSkills, false);
}

// ── isLegacyFlatConfig ──────────────────────────────────────────────────
ok("isLegacyFlatConfig detects v1 webdav", isLegacyFlatConfig({ webdavUrl: "x" }));
ok("isLegacyFlatConfig detects v1 s3", isLegacyFlatConfig({ s3Bucket: "b" }));
ok("isLegacyFlatConfig rejects v2 store", !isLegacyFlatConfig({ version: 2, profiles: {} }));
ok("isLegacyFlatConfig rejects empty", !isLegacyFlatConfig({}));

// ── resolveSecret ───────────────────────────────────────────────────────
eq("resolveSecret plaintext passthrough", resolveSecret("hunter2"), "hunter2");
{
  process.env.PI_SYNC_TEST_SECRET = "s3cr3t";
  eq("resolveSecret $VAR", resolveSecret("$PI_SYNC_TEST_SECRET"), "s3cr3t");
  eq("resolveSecret ${VAR}", resolveSecret("${PI_SYNC_TEST_SECRET}"), "s3cr3t");
  delete process.env.PI_SYNC_TEST_SECRET;
}
throws("resolveSecret unset $VAR throws", () => resolveSecret("$PI_SYNC_DEFINITELY_UNSET_VAR"));
eq("resolveSecret literal $ + non-var passes through", resolveSecret("$ raw text"), "$ raw text");

// ── matchProfileIdFromLine ──────────────────────────────────────────────
{
  const ids = ["prod", "prod2", "dev"];
  eq("match by (id) marker", matchProfileIdFromLine("● prod2 — S3 bucket", ids), "prod2");
  eq("match no substring cross-hit", matchProfileIdFromLine("○ prod — WebDAV x", ids), "prod");
  eq("match parenthesized", matchProfileIdFromLine("Foo (dev) — x", ids), "dev");
}

// ── selectBackupsToPrune ────────────────────────────────────────────────
eq("DEFAULT_BACKUP_RETENTION is 5", DEFAULT_BACKUP_RETENTION, 5);
{
  const names = [
    "x.bak-20260101000001",
    "x.bak-20260101000002",
    "x.bak-20260101000003",
    "x.bak-20260101000004",
  ];
  const victims = selectBackupsToPrune(names, 2);
  eq("selectBackupsToPrune keeps 2 newest", victims.sort(), ["x.bak-20260101000001", "x.bak-20260101000002"]);
}
eq("selectBackupsToPrune keep >= len → none", selectBackupsToPrune(["a", "b"], 5), []);

// ── pruneTimestampedBackups (fs) ────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "pi_sync_prune_"));
  try {
    for (let i = 1; i <= 7; i++) {
      writeFileSync(join(dir, `models.json.bak-2026010100000${i}`), "x");
    }
    // an unrelated file that must survive
    writeFileSync(join(dir, "models.json"), "keep");
    const removed = pruneTimestampedBackups({
      dir,
      pattern: /^models\.json\.bak-\d{14}$/,
      keep: 3,
    });
    eq("pruneTimestampedBackups removed 4", removed.length, 4);
    const left = readdirSync(dir).filter((n) => /\.bak-/.test(n));
    eq("pruneTimestampedBackups kept 3", left.length, 3);
    ok("pruneTimestampedBackups kept unrelated file", readdirSync(dir).includes("models.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── normalizeArchiveEntry ───────────────────────────────────────────────
eq("normalizeArchiveEntry strips ./", normalizeArchiveEntry("./config/models.json"), "config/models.json");
eq("normalizeArchiveEntry backslashes", normalizeArchiveEntry("config\\settings.json"), "config/settings.json");
eq("normalizeArchiveEntry trailing slash", normalizeArchiveEntry("skills/"), "skills");
eq("normalizeArchiveEntry dot only", normalizeArchiveEntry("."), "");

// ── validateArchiveEntries ──────────────────────────────────────────────
ok("validateArchiveEntries accepts valid layout", (() => {
  validateArchiveEntries(["config/models.json", "skills/foo/SKILL.md", "extensions/bar/index.ts"]);
  return true;
})());
throws("validateArchiveEntries rejects traversal", () => validateArchiveEntries(["../etc/passwd"]));
throws("validateArchiveEntries rejects absolute", () => validateArchiveEntries(["/etc/passwd"]));
throws("validateArchiveEntries rejects drive", () => validateArchiveEntries(["C:/Windows/x"]));
throws("validateArchiveEntries rejects unknown top-level", () => validateArchiveEntries(["secrets/x"]));
throws("validateArchiveEntries rejects unknown config file", () => validateArchiveEntries(["config/id_rsa"]));
throws("validateArchiveEntries rejects empty", () => validateArchiveEntries([]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 1 - 1 : 1);
