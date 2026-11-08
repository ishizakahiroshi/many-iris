[CmdletBinding()]
param(
    [ValidateSet('test','build','check')][string]$Mode='test',
    [switch]$Release,
    [switch]$Online,
    [string]$CachePath=(Join-Path $PSScriptRoot 'cargo-cache')
)
$ErrorActionPreference='Stop'
$toolchain=Join-Path $env:USERPROFILE '.rustup\toolchains\1.98-x86_64-pc-windows-msvc\bin'
$msvc='C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207'
$sdk='C:\Program Files (x86)\Windows Kits\10'
$sdkVersion='10.0.26100.0'
if (!(Test-Path -LiteralPath (Join-Path $toolchain 'cargo.exe'))) { throw 'Fixed Rust 1.98 toolchain unavailable' }
$env:RUSTC=Join-Path $toolchain 'rustc.exe'
$env:CARGO_HOME=$CachePath
$env:PATH="$toolchain;$msvc\bin\Hostx64\x64;$env:PATH"
$env:LIB="$msvc\lib\x64;$sdk\Lib\$sdkVersion\um\x64;$sdk\Lib\$sdkVersion\ucrt\x64"
$env:INCLUDE="$msvc\include;$sdk\Include\$sdkVersion\ucrt;$sdk\Include\$sdkVersion\shared;$sdk\Include\$sdkVersion\um"
$cargoArgs=@($Mode,'--locked','--manifest-path',(Join-Path $PSScriptRoot 'Cargo.toml'))
if (!$Online) { $cargoArgs+='--offline' }
if ($Release) { $cargoArgs+='--release' }
& (Join-Path $toolchain 'cargo.exe') @cargoArgs
exit $LASTEXITCODE
