# pi-bootstrap.ps1
# Pull the latest Pi config backup from WebDAV onto a new machine.
#
# Usage:
#   .\pi-bootstrap.ps1 -WebdavUrl "https://your-webdav.example/dav/Pi" -User "your-user" -Pass "your-app-password"
#
# Or set env vars (recommended):
#   $env:PI_WEBDAV_URL  = "https://your-webdav.example/dav/Pi"
#   $env:PI_WEBDAV_USER = "your-user"
#   $env:PI_WEBDAV_PASS = "your-app-password"
#   .\pi-bootstrap.ps1
#
# Security: never commit real credentials. Prefer app-specific passwords
# and store them only in env vars / your password manager.

param(
    [string]$WebdavUrl = $env:PI_WEBDAV_URL,
    [string]$User = $env:PI_WEBDAV_USER,
    [string]$Pass = $env:PI_WEBDAV_PASS
)

$ErrorActionPreference = "Stop"

if (-not $WebdavUrl -or -not $User -or -not $Pass) {
    Write-Host "Usage: .\pi-bootstrap.ps1 -WebdavUrl <url> -User <user> -Pass <pass>" -ForegroundColor Red
    Write-Host "Or set PI_WEBDAV_URL, PI_WEBDAV_USER, PI_WEBDAV_PASS env vars" -ForegroundColor Yellow
    exit 1
}

$WebdavUrl = $WebdavUrl.TrimEnd('/')
$pair = "${User}:${Pass}"
$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$headers = @{ Authorization = "Basic $auth"; Depth = "1" }

Write-Host "[1/5] Listing backups on WebDAV..." -ForegroundColor Cyan
$resp = Invoke-RestMethod -Uri $WebdavUrl -Method PROPFIND -Headers $headers -ContentType "application/xml"

# Parse XML for filenames
$files = ([regex]'<d:href>([^<]+)</d:href>').Matches($resp) |
    ForEach-Object { $_.Groups[1].Value } |
    Where-Object { $_ -match 'pi_sync_backup_.*\.zip$' } |
    Sort-Object -Descending

if ($files.Count -eq 0) {
    Write-Host "No backups found on WebDAV!" -ForegroundColor Red
    exit 1
}

$latest = $files[0]
$name = [System.IO.Path]::GetFileName($latest)
Write-Host "[2/5] Latest backup: $name" -ForegroundColor Green

$tempZip = "$env:TEMP\$name"
Write-Host "[3/5] Downloading..." -ForegroundColor Cyan
Invoke-WebRequest -Uri "$WebdavUrl/$name" -Headers @{ Authorization = "Basic $auth" } -OutFile $tempZip

$tempDir = "$env:TEMP\pi_restore_$(Get-Date -Format 'yyyyMMddHHmmss')"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

Write-Host "[4/5] Extracting..." -ForegroundColor Cyan
tar -xf $tempZip -C $tempDir

$agentDir = "$env:USERPROFILE\.pi\agent"
$backupSuffix = "bak-$(Get-Date -Format 'yyyyMMddHHmmss')"

# Restore config
if (Test-Path "$tempDir\config") {
    Write-Host "  → Restoring config files..." -ForegroundColor Yellow
    Get-ChildItem "$tempDir\config" | ForEach-Object {
        $dest = Join-Path $agentDir $_.Name
        if (Test-Path $dest) {
            Copy-Item $dest "$dest.$backupSuffix"
            Write-Host "    Backup: $($_.Name) → $($_.Name).$backupSuffix"
        }
        Copy-Item $_.FullName $dest -Force
        Write-Host "    Restored: $($_.Name)" -ForegroundColor Green
    }
}

# Restore skills
if (Test-Path "$tempDir\skills") {
    Write-Host "  → Restoring skills..." -ForegroundColor Yellow
    $skillsDest = "$agentDir\skills"
    if (Test-Path $skillsDest) {
        Rename-Item $skillsDest "skills-$backupSuffix"
        Write-Host "    Backup: skills → skills-$backupSuffix"
    }
    Copy-Item "$tempDir\skills" $skillsDest -Recurse
    Write-Host "    Skills restored" -ForegroundColor Green
}

# Restore extensions
if (Test-Path "$tempDir\extensions") {
    Write-Host "  → Restoring extensions..." -ForegroundColor Yellow
    $extDest = "$agentDir\extensions"
    if (Test-Path $extDest) {
        Rename-Item $extDest "extensions-$backupSuffix"
        Write-Host "    Backup: extensions → extensions-$backupSuffix"
    }
    Copy-Item "$tempDir\extensions" $extDest -Recurse
    Write-Host "    Extensions restored" -ForegroundColor Green
}

# Cleanup
Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[5/5] Done! Pi config restored to $agentDir" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Restart Pi (or /reload)"
Write-Host "  2. Run: pi update --extensions  (to install packages from settings.json)"
Write-Host "  3. /sync pull  (to pull future updates)"
