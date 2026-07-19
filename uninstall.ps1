# pican uninstaller for Windows — removes binary, auto-start, and runtime
# state. Triggered as npm preuninstall hook when `pi remove npm:@yeshwanthyk/pican@beta`
# is run. The npm package directory itself is removed by npm after this script.
#
# Kept intact (survives uninstall — preserves data for reinstall):
#   - ~/.pi/agent/pican.sqlite          (settings, scratchpads, project prefs)
#   - ~/.pi/agent/pican-memory.sqlite   (memory skill data)
#   - ~/.config/pican/env               (PICAN_TOKEN, PATH, etc.)
#   - ~/.pi/agent/sessions/              (session files)

$ErrorActionPreference = 'Continue'

if ($env:PICAN_INSTALL_DIR) {
  $Binary = Join-Path $env:PICAN_INSTALL_DIR 'pican.exe'
} else {
  $Binary = Join-Path $HOME '.pi\agent\bin\pican.exe'
}
$ConfigDir = Join-Path $HOME '.config\pican'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function Info($msg) { Write-Host "-> $msg" }
function Skip($msg) { Write-Host "   (skipped) $msg" }

Write-Host ''
Info 'pican uninstaller (Windows)'
Write-Host ''

# Stop running instance
$proc = Get-Process -Name 'pican' -ErrorAction SilentlyContinue
if ($proc) {
  Info 'Stopping running pican instance...'
  $proc | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

# Remove binary (and any leftover from a previous swap)
if (Test-Path $Binary) {
  Info "Removing binary: $Binary"
  Remove-Item $Binary -Force -ErrorAction SilentlyContinue
} else {
  Skip "binary not found at $Binary"
}
Remove-Item "$Binary.old" -Force -ErrorAction SilentlyContinue

# Remove version file
$versionFile = Join-Path $HOME '.pi\agent\pican-version'
if (Test-Path $versionFile) {
  Info "Removing version file: $versionFile"
  Remove-Item $versionFile -Force
} else {
  Skip 'version file not found'
}

# Remove runtime state
$stateFile = Join-Path $HOME '.pi\agent\pican\pican-state.json'
if (Test-Path $stateFile) {
  Info "Removing state file: $stateFile"
  Remove-Item $stateFile -Force
} else {
  Skip 'state file not found'
}
$stateDir = Join-Path $HOME '.pi\agent\pican'
if ((Test-Path $stateDir) -and -not (Get-ChildItem $stateDir)) {
  Remove-Item $stateDir -Force
}

# Clean up stale npm temp dirs
$temps = @(Get-Item (Join-Path $HOME '.pi\agent\npm\node_modules\@yeshwanthyk\.pican-*') -ErrorAction SilentlyContinue)
foreach ($t in $temps) { Remove-Item $t.FullName -Recurse -Force -ErrorAction SilentlyContinue }
if ($temps.Count -gt 0) { Info "Cleaned up $($temps.Count) stale npm temp dir(s)" }

# Remove auto-start (Run key + hidden launcher; the env file is kept)
Remove-ItemProperty -Path $RunKey -Name 'pican' -ErrorAction SilentlyContinue
Remove-Item (Join-Path $ConfigDir 'pican-start.ps1') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $ConfigDir 'pican-start.vbs') -Force -ErrorAction SilentlyContinue
Info 'Removed Windows auto-start (Run key + launcher)'

Info 'pican service and binary removed.'
Info 'Data preserved: ~/.pi/agent/pican.sqlite, ~/.pi/agent/pican-memory.sqlite, ~/.config/pican/env'
Write-Host ''
