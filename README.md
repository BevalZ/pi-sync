# pi-sync

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![release](https://img.shields.io/github/v/release/BevalZ/pi-sync?display_name=tag&sort=semver)](https://github.com/BevalZ/pi-sync/releases)

WebDAV-based config sync for [Pi](https://github.com/earendil-works/pi-coding-agent) — backup and restore **models**, **settings**, **skills**, and **extensions** across machines.

One command on your main machine (`/sync push`), one command on a new machine (`/sync pull`).

## Why

If you run Pi on multiple PCs / WSL / servers, reinstalling models, skills, and extensions by hand is painful. `pi-sync` packages your agent home into a timestamped zip, uploads it to any WebDAV folder, and restores it with local safety backups.

## Install

Requires [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) and a WebDAV endpoint (TeraCLOUD, 坚果云 / Jianguoyun, Nextcloud, ownCloud, self-hosted, …).

```bash
pi install git:github.com/BevalZ/pi-sync
```

Then restart Pi or run `/reload`.

## Usage

```
/sync           Interactive menu (upload / download / configure)
/sync push      Upload current config to WebDAV
/sync pull      Download latest backup from WebDAV and restore
```

### First-time setup

```bash
# 1. Install
pi install git:github.com/BevalZ/pi-sync

# 2. Configure WebDAV (interactive)
/sync → "Configure Sync Settings"
#    enter URL / user / password
#    tip: set password to $PI_WEBDAV_PASS and export that env var

# 3. From your main machine
/sync push

# 4. On a new machine (after install + configure)
/sync pull
```

### What gets synced

| Component | Default | Notes |
|-----------|---------|-------|
| Config | ON | `models.json`, `settings.json`, `auth.json` |
| Skills | ON | entire `~/.pi/agent/skills` |
| Extensions | ON | `~/.pi/agent/extensions` (sync plugin itself excluded from the zip) |

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

Then install Pi and finish with `/sync pull` for future updates.

## Security

- WebDAV credentials are stored locally in `~/.pi/agent/sync_config.json`
- Prefer **app-specific passwords** (not your main account password)
- Prefer env-var references: set password to `$PI_WEBDAV_PASS` in the UI, then export that variable in your shell profile
- Backups may include `auth.json` / API keys if those options are enabled — treat the WebDAV folder as sensitive
- Never commit real WebDAV URLs with credentials into git

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| HTTP 401 / 403 | Check user/password; use app password; confirm URL includes the correct DAV path |
| PROPFIND fails / empty list | Server may block PROPFIND; try another WebDAV provider; ensure Depth:1 is allowed |
| tar / zip errors | Need a working `tar` on PATH (Windows 10+ has one; Git Bash / WSL also fine) |
| Pull overwrote something | Look for `*.bak-*` files and `skills-backup-*` / `extensions-backup-*` folders next to the agent dir |
| Plugin missing after pull | Re-run `pi install git:github.com/BevalZ/pi-sync` — the sync package excludes itself from the archive |

## Structure

```text
pi-sync/
  package.json
  LICENSE
  README.md
  pi-bootstrap.ps1
  extensions/
    sync/
      index.ts          # /sync command
    _shared/
      json-io.ts
      enhanced-select.ts
      spawn.ts
      fetch-utils.ts
      box-drawing.ts
```

## Changelog

### v1.0.1

- Tag backup zip names with host platform (`windows11` / `macos` / `linux` / …)
- Remove example credentials from bootstrap script comments
- Add MIT `LICENSE` and expand README (security, restore safety, troubleshooting)

### v1.0.0

- Initial public release: `/sync` push · pull · configure over WebDAV
- Windows bootstrap helper script

## License

MIT — see [LICENSE](./LICENSE).
