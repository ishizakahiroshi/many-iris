[CmdletBinding()]
param(
    [string]$Binary = (Join-Path $PSScriptRoot '../target/release/many-iris.exe'),
    [string]$StateDirectory = (Join-Path $PSScriptRoot '../.state'),
    [ValidateRange(0,65535)][int]$Port = 0,
    [string]$ExecutorConfig,
    [switch]$Doctor
)
$ErrorActionPreference = 'Stop'
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path
$statePath = [IO.Path]::GetFullPath($StateDirectory)
[IO.Directory]::CreateDirectory($statePath) | Out-Null
if ($Doctor) { & $binaryPath --doctor --db (Join-Path $statePath 'iris.sqlite3'); exit $LASTEXITCODE }
$launchId = [Guid]::NewGuid().ToString('N')
$readyPath = Join-Path $statePath "ready-$launchId.json"
$shutdownPath = Join-Path $statePath "shutdown-$launchId.signal"
# ShellExecute starts the executable in its own hidden Windows console without
# inheriting the invoking shell's capture pipes. Start-Process stream redirects
# still let an ambient inheritable pipe handle reach the server on Windows.
# ShellExecute cannot redirect streams: readiness and exit code are the startup
# diagnostics; no empty or misleading startup_error_file is advertised.
$nativeArgs = @('--db',(Join-Path $statePath 'iris.sqlite3'),'--port',"$Port",'--ready-file',$readyPath,'--shutdown-file',$shutdownPath)
if ($ExecutorConfig) {
    $configPath = (Resolve-Path -LiteralPath $ExecutorConfig).Path
    if (-not [IO.File]::Exists($configPath)) { throw 'Executor configuration must be an existing file.' }
    $nativeArgs += @('--executor-config',$configPath)
}
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $binaryPath
foreach ($argument in $nativeArgs) { $startInfo.ArgumentList.Add($argument) }
$startInfo.WorkingDirectory = Split-Path -Parent $binaryPath
$startInfo.UseShellExecute = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$ownedProcess = [Diagnostics.Process]::Start($startInfo)
# Startup emits one safe receipt; no token is printed by the executable.
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while (-not (Test-Path -LiteralPath $readyPath) -and [DateTime]::UtcNow -lt $deadline) {
    $ownedProcess.Refresh()
    if ($ownedProcess.HasExited) { throw "Many Iris did not start (exit code $($ownedProcess.ExitCode)). Run the foreground executable for startup diagnostics." }
    Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $readyPath)) { throw "Startup did not finish. Owned process ID: $($ownedProcess.Id). Do not start a second instance." }
$ready = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
$receipt = [ordered]@{ url=$ready.url; synthetic=$ready.synthetic; pid=$ready.pid; ready_file=$readyPath; binary=$binaryPath; binary_sha256=(Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash; startup_error_file=$null; startup_diagnostics='ready-file-and-process-exit; foreground-for-stream-output' }
$receipt | ConvertTo-Json -Compress
