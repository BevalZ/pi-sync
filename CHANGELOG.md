# Changelog

All notable changes to pi-sync are documented here. Versions follow the
`major.minor.patch` scheme recorded in `package.json`.

## 1.4.0

Security hardening, robustness, and the first pure-logic unit-test suite.

### Security

- **Env-var secrets fail loudly.** `resolveSecret` now supports both `$VAR` and
  `${VAR}` and throws with the variable name when the referenced environment
  variable is unset, instead of silently sending the literal `$VAR` string as a
  password/key (which produced confusing 401/403 errors).
  **Behavior change:** a profile that references an unset env var now reports a
  clear error from `/sync` rather than failing opaquely.
- **ZIP bomb guard.** Legacy ZIP extraction enforces a 512 MiB per-entry and
  2 GiB per-archive uncompressed limit, bounds `inflateRawSync` output, and
  pre-checks the central directory before writing anything to disk.
- **Symlink rejection on restore.** Extracted archives are scanned for symlinks
  before any file is copied into the agent directory; an archive containing a
  symlink is refused. This closes the gap where the `tar` restore path did not
  have the realpath-boundary protection the pure-JS ZIP path already had.

### Fixed

- **Profile-line matching no longer cross-matches prefixes.** Selecting/deleting
  profiles whose ids are substrings of one another (e.g. `prod` vs `prod2`) now
  resolves to the correct id via boundary-aware matching.
- **Per-endpoint S3 clock skew.** SigV4 clock-skew correction is cached per
  `endpoint|region` instead of in a single module-global, so multi-profile
  uploads to different backends no longer leak one host's skew into another.
  A failed skew probe stays retriable instead of being marked done.

### Added

- **Backup retention.** Timestamped safety backups are pruned to the newest 5
  per family: `sync_config.json.bak-*`, `models/settings/auth.json.bak-*`,
  `skills-backup-*`, and `extensions-backup-*`.
- **Streaming downloads.** WebDAV and S3 downloads stream the response body to
  disk via `Readable.fromWeb` + `pipeline` instead of buffering the whole
  archive in memory. (Uploads remain buffered: S3 SigV4 needs the payload hash
  up front, and archives are typically a few MB.)
- **Network retry.** List/upload/download operations retry transient network
  faults (ECONNRESET, ETIMEDOUT, socket hang up, …) with full-jitter
  exponential backoff. User aborts (Esc) stop immediately; HTTP-status errors
  are not blindly retried.
- **Unit tests.** New `scripts/core-test.mjs` (46 cases) covers config
  migration, archive validation, backup sorting/pruning, secret resolution, and
  profile-line matching. Wired into `npm test` alongside the S3 and ZIP suites.

### Internal

- Pure logic extracted to module-level exports for testability; `readJsonSafe`
  documented as shallow-merge; temp-dir names for tar/zip work carry a random
  suffix to avoid concurrent collisions.

## 1.3.8

- Loop the main `/sync` menu so navigating back from a submenu returns to the
  menu instead of the conversation.

## 1.3.7

- Pure-JS ZIP extraction for legacy Windows backups (GNU tar cannot read the
  real ZIP files Windows `tar -a` produces).

## 1.3.6

- Use `.tar.gz` archives for cross-platform restore.

## 1.3.5

- Hard-fix stack overflow on restore.

## 1.3.4

- Fix `errMsg` infinite-recursion stack overflow.

## 1.3.3

- Padded backup dates; accept `./` archive roots.

## 1.3.2

- Code-quality cleanup (no behavior change).

## 1.3.1

- Multi-profile upload; docs polish.

## 1.3.0

- Multi-profile sync configs.

## 1.2.1

- Auto-correct S3 clock skew for SigV4.

## 1.2.0

- Add S3-compatible backend.

## 1.1.0

- tar preflight check + restore report.
