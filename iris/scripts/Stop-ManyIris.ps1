[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReadyFile,
    [Parameter(Mandatory)][string]$Binary
)
$ErrorActionPreference = 'Stop'
$readyPath = (Resolve-Path -LiteralPath $ReadyFile).Path
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path
$ready = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
if (-not $ready.synthetic -or -not $ready.shutdown_file -or -not $ready.pid) { throw 'Not a supported Many Iris startup receipt.' }
$ownedId = [int]$ready.pid
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ownedId" -Property ProcessId,ExecutablePath
if (-not $processInfo) { 'Many Iris is already stopped.'; exit 0 }
if (-not [string]::Equals([IO.Path]::GetFullPath($processInfo.ExecutablePath),$binaryPath,[StringComparison]::OrdinalIgnoreCase)) { throw 'The process ID belongs to a different executable. Nothing was stopped.' }
$shutdownPath = [IO.Path]::GetFullPath([string]$ready.shutdown_file)
if ((Split-Path -Leaf $readyPath) -notmatch '^ready-([a-f0-9]{32})\.json$') { throw 'Unknown startup receipt name.' }
$launchId = $Matches[1]
$expectedMarker = Join-Path (Split-Path -Parent $readyPath) "shutdown-$launchId.signal"
if (-not [string]::Equals($shutdownPath,$expectedMarker,[StringComparison]::OrdinalIgnoreCase)) { throw 'Shutdown marker does not belong to this launch.' }
if (-not [string]::Equals((Split-Path -Parent $shutdownPath),(Split-Path -Parent $readyPath),[StringComparison]::OrdinalIgnoreCase)) { throw 'Shutdown marker is outside the startup receipt directory.' }
$markerStream = [IO.File]::Open($shutdownPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $markerBytes = [Text.Encoding]::UTF8.GetBytes('stop'); $markerStream.Write($markerBytes,0,$markerBytes.Length); $markerStream.Flush($true) } finally { $markerStream.Dispose() }
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ((Get-Process -Id $ownedId -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
if (Get-Process -Id $ownedId -ErrorAction SilentlyContinue) { throw 'Graceful stop is not confirmed. Do not start another instance or assume the work stopped.' }
'Many Iris and its owned synthetic executor stopped.'
