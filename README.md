# pi-sync

**English** | [简体中文](./README.zh-CN.md)

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![release](https://img.shields.io/github/v/release/BevalZ/pi-sync?display_name=tag&sort=semver)](https://github.com/BevalZ/pi-sync/releases)

WebDAV / S3 config sync for [Pi](https://github.com/earendil-works/pi-coding-agent) — backup and restore **models**, **settings**, **skills**, and **extensions** across machines.

Run `/sync`, pick an action from the menu. One machine uploads; another downloads and restores. Supports **WebDAV** (Nextcloud, 坚果云, …) and **S3-compatible** storage (AWS S3, Cloudflare R2, Alibaba OSS, MinIO, …).

<p align="center">
  <img src="docs/sync-menu.png" alt="Pi Sync menu" width="720" />
</p>

<p align="center"><sub><b>Pi Synchronization</b> — interactive menu after <code>/sync</code></sub></p>

## Why

If you run Pi on multiple PCs / WSL / servers, reinstalling models, skills, and extensions by hand is painful. `pi-sync` packages your agent home into a timestamped zip, uploads it to your cloud storage, and restores it with local safety backups.

## Install

Requires [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). Works with any WebDAV or S3-compatible storage.

```bash
pi install git:github.com/BevalZ/pi-sync
```

Then restart Pi or run `/reload`.

## Usage

Type **`/sync`** in Pi. There are no CLI subcommands — everything goes through the interactive menu:

| Menu item | What it does |
|-----------|----------------|
| ☁️ **Upload Backup (Backup to cloud)** | Zip current config and upload to storage |
| 📥 **Download Backup (Restore from cloud)** | List remote backups, download one, restore with confirmation |
| ⚙️ **Configure Sync Settings** | Storage type, credentials, and what to include |
| ❌ **Cancel** | Leave the menu |

Keyboard hints (as shown in the TUI): `↵` select · `↑↓` navigate · `Esc` cancel.

### First-time setup

```bash
# 1. Install
pi install git:github.com/BevalZ/pi-sync

# 2. Open the menu (first run starts the setup wizard if no storage is configured)
/sync

# 3. If needed: Configure Sync Settings
#    select storage backend (WebDAV / S3) and enter credentials
#    tip: set passwords to $PI_WEBDAV_PASS / $PI_S3_SECRET_KEY and export those env vars

# 4. On your main machine → Upload Backup (Backup to cloud)
# 5. On a new machine (after install + configure) → Download Backup (Restore from cloud)
```

### What gets synced

| Component | Default | Notes |
|-----------|---------|-------|
| Config | ON | `models.json`, `settings.json`, `auth.json` |
| Skills | ON | entire `~/.pi/agent/skills` |
| Extensions | ON | `~/.pi/agent/extensions` (the sync plugin itself is excluded from the zip) |

Toggle any of these under **Configure Sync Settings**.

### Backup filename

Archives look like:

```text
pi_sync_backup_2026-7-14_20260714120000_windows11.zip
```

The trailing platform tag (`windows11` / `windows10` / `macos` / `linux`) shows which host created the backup.

### Safety on restore

- Existing config files get a timestamped `.bak` copy before overwrite
- Existing skills / extensions folders are renamed to `*-backup-<timestamp>` before replace/merge
- Restore shows a plan and asks for confirmation
- After a successful restore you can reload the agent runtime to apply skills/extensions

## Bootstrap (new Windows machine, no Pi yet)

If Pi is not installed yet, you can still pull the latest zip with the helper script:

```powershell
# Prefer env vars so secrets never land in shell history
$env:PI_WEBDAV_URL  = "https://your-webdav.example/dav/Pi"
$env:PI_WEBDAV_USER = "your-user"
$env:PI_WEBDAV_PASS = "your-app-password"
.\pi-bootstrap.ps1
```

Or one-liner placeholders (replace before running):

```powershell
$url="https://your-webdav.example/dav/Pi"; $user="your-user"; $pass="your-app-password"
$pair="$user`:$pass"; $auth=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$resp=Invoke-RestMethod -Uri $url -Method PROPFIND -Headers @{Authorization="Basic $auth";Depth="1"} -ContentType "application/xml"
$files=([regex]'<d:href>([^<]+)</d:href>').Matches($resp) | %{$_.Groups[1].Value} | ?{$_ -match "pi_sync_backup_.*\.zip$"} | Sort-Object -Descending
$latest=$files[0]; $name=Split-Path $latest -Leaf
Invoke-WebRequest -Uri "$url/$name" -Headers @{Authorization="Basic $auth"} -OutFile "$env:TEMP\$name"
```

Then install Pi and use **Download Backup** from `/sync` for future updates.

> **Note:** `pi-bootstrap.ps1` currently supports WebDAV only. For S3, install Pi first with `pi install git:github.com/BevalZ/pi-sync`, then use `/sync` to restore.

## Security

- Credentials are stored locally in `~/.pi/agent/sync_config.json`
- Prefer **app-specific passwords / API tokens** (not your main account password)
- Prefer env-var references: set password to `$PI_WEBDAV_PASS` or `$PI_S3_SECRET_KEY` in the UI, then export that variable in your shell profile
- Backups may include `auth.json` / API keys if those options are enabled — treat your cloud storage as sensitive
- Never commit real credentials into git

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| tar / zip errors | Need a working `tar` on PATH (Windows 10+ has one; Git Bash / WSL also fine) |
| Restore overwrote something | Look for `*.bak-*` files and `skills-backup-*` / `extensions-backup-*` folders next to the agent dir |
| Plugin missing after restore | Re-run `pi install git:github.com/BevalZ/pi-sync` — the sync package excludes itself from the archive |

### WebDAV Backend

| Symptom | Fix |
|---------|-----|
| HTTP 401 / 403 | Check user/password; use app password; confirm URL includes the correct DAV path |
| PROPFIND fails / empty list | Server may block PROPFIND; try another WebDAV provider; ensure Depth:1 is allowed |

### S3 Backend

| Symptom | Fix |
|---------|-----|
| HTTP 403 / SignatureDoesNotMatch | Check endpoint URL format; verify Access Key / Secret Key; ensure region is correct (use `auto` for R2) |
| List returns empty | Verify the bucket name and S3 Path prefix; check IAM / API token permissions include `s3:ListBucket` |

## Structure

```text
pi-sync/
  package.json
  LICENSE
  README.md
  README.zh-CN.md
  pi-bootstrap.ps1
  docs/
    sync-menu.png          # /sync menu screenshot
  extensions/
    sync/
      index.ts             # /sync command
      storage.ts           # storage interface + factory
      storage-webdav.ts    # WebDAV backend
      storage-s3.ts        # S3 backend (AWS SigV4, zero deps)
    _shared/
      json-io.ts
      enhanced-select.ts
      spawn.ts
      fetch-utils.ts
      box-drawing.ts
```

## Changelog

### v1.1.0

- Add **S3-compatible storage** backend (AWS S3, Cloudflare R2, Alibaba OSS, MinIO, …)
  - AWS Signature V4 signing with zero npm dependencies
  - Storage type selector in setup wizard and settings menu
  - S3 Path support for nested bucket folders (e.g. `backup/xxx/pi/`)
- Refactor storage layer: `storage.ts` interface + `storage-webdav.ts` / `storage-s3.ts` backends

### v1.0.1

- Tag backup zip names with host platform (`windows11` / `macos` / `linux` / …)
- Remove example credentials from bootstrap script comments
- Add MIT `LICENSE` and expand README (security, restore safety, troubleshooting, menu screenshot)

### v1.0.0

- Initial public release: interactive `/sync` menu over WebDAV
  - Upload Backup · Download Backup · Configure Sync Settings
- Windows bootstrap helper script

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

This open-source project is linked and recognized by the [LINUX DO](https://linux.do) community.
