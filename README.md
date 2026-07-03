# pi-sync

WebDAV-based config sync for [Pi](https://github.com/earendil-works/pi-coding-agent) — backup and restore models, settings, skills, and extensions across machines.

## Install

```bash
pi install git:github.com/BevalZ/pi-sync
```

## Usage

```
/sync           Interactive menu (upload / download / configure)
/sync push      One-click upload current config to WebDAV
/sync pull      One-click download latest backup from WebDAV
```

### First-time setup

```bash
# 1. Install the package
pi install git:github.com/BevalZ/pi-sync

# 2. Configure WebDAV
/sync → "Configure Sync Settings" → enter URL / user / password

# 3. Pull config from cloud (on new machine)
/sync pull

# 4. Push config to cloud (from your main machine)
/sync push
```

## Bootstrap (new machine, one-liner)

```powershell
# PowerShell - downloads config directly from WebDAV
$url="https://your-webdav.com/dav/Pi"; $user="your-user"; $pass="your-pass"
$pair="$user`:$pass"; $auth=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$resp=Invoke-RestMethod -Uri $url -Method PROPFIND -Headers @{Authorization="Basic $auth";Depth="1"} -ContentType "application/xml"
$files=([regex]'<d:href>([^<]+)</d:href>').Matches($resp) | %{$_.Groups[1].Value} | ?{$_ -match "pi_sync_backup_.*\.zip$"} | Sort-Object -Descending
$latest=$files[0]; $name=Split-Path $latest -Leaf
Invoke-WebRequest -Uri "$url/$name" -Headers @{Authorization="Basic $auth"} -OutFile "$env:TEMP\$name"
mkdir -Force "$env:USERPROFILE\.pi\agent"
tar -xf "$env:TEMP\$name" -C "$env:TEMP\pi_restore"
# Then manually copy config/, skills/, extensions/ to ~/.pi/agent/
```

## Structure

```
pi-sync/
  package.json
  extensions/
    sync/
      index.ts          # /sync command
    _shared/
      json-io.ts         # JSON read/write helpers
      enhanced-select.ts # Interactive select UI
      spawn.ts           # Child process runner
      fetch-utils.ts     # HTTP fetch with timeout
      box-drawing.ts     # TUI box drawing
```

## License

MIT
