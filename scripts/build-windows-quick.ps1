<#
.SYNOPSIS
  One-command Windows build of open-clipper.exe.

.DESCRIPTION
  Installs anything missing (Visual Studio C++ Build Tools, Git, Node.js, Rust, CMake),
  builds static FFmpeg with vcpkg in C:\ffmpeg\vcpkg, downloads the ONNX Runtime used for
  vocals isolation, then builds src-tauri\target-fast\release\open-clipper.exe.

  Safe to re-run: finished steps are skipped, so a second run only rebuilds the app.

  By default local speech recognition uses the CPU sherpa-onnx prebuilds (saves ~20 min).
  Pass -GpuSpeech to build the DirectML speech library instead. Cloud transcription
  (Groq / OpenRouter key) and GPU reframing work either way.

.EXAMPLE
  # From the project folder, in PowerShell:
  powershell -ExecutionPolicy Bypass -File scripts\build-windows-quick.ps1
#>
[CmdletBinding()]
param(
  [switch]$GpuSpeech,
  # Don't start the app when the build finishes (used by CI).
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is far faster without the progress bar

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$VcpkgRoot = "C:\ffmpeg\vcpkg"             # build.rs and .cargo\config.toml expect this path
$FfmpegLib = Join-Path $VcpkgRoot "installed\x64-windows-static\lib\avcodec.lib"
# ffmpeg-next 8.1 (src-tauri/Cargo.lock) needs FFmpeg 8.1; vcpkg 2026.10+ ships FFmpeg 9.
$VcpkgTag = "2026.07.29"
$FfmpegVersionPattern = '^ffmpeg_8\.1\.'
$OrtVersion = "1.23.0"
$OrtDir = Join-Path $ProjectRoot "third_party\onnxruntime-directml\$OrtVersion"
$WinRuntimeDir = Join-Path $ProjectRoot "src-tauri\resources\win-runtime"
$ReleaseDir = Join-Path $ProjectRoot "src-tauri\target-fast\release"
$Started = Get-Date

function Step([string]$Message) {
  $elapsed = [int]((Get-Date) - $Started).TotalMinutes
  Write-Host ""
  Write-Host "==> [$elapsed min] $Message" -ForegroundColor Cyan
}

function Has([string]$Command) {
  [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user;$env:USERPROFILE\.cargo\bin"
}

function Winget-Install([string]$Id, [string[]]$Extra = @()) {
  if (-not (Has "winget")) {
    throw "$Id is needed but winget is missing. Install 'App Installer' from the Microsoft Store (or install $Id yourself), then run this script again."
  }
  Write-Host "Installing $Id ..."
  # winget returns non-zero for "already installed"; success is checked by the caller.
  & winget install --id $Id -e --accept-source-agreements --accept-package-agreements --silent @Extra | Out-Host
  Refresh-Path
}

function Invoke-Checked([string]$What, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)." }
}

function Expand-NuGet([string]$Id, [string]$Version, [string]$Destination) {
  $package = Join-Path $env:TEMP "$Id.$Version.zip"
  Invoke-WebRequest "https://www.nuget.org/api/v2/package/$Id/$Version" -OutFile $package
  if (Test-Path $Destination) { Remove-Item -Recurse -Force $Destination }
  Expand-Archive $package -DestinationPath $Destination
  Remove-Item $package
}

Set-Location $ProjectRoot
Write-Host "Open Clipper quick build in $ProjectRoot" -ForegroundColor Green

if ($ProjectRoot.Path.Length -gt 60) {
  Write-Warning "The project path is long ($($ProjectRoot.Path.Length) characters). If the build fails with path errors, move the folder to something short like C:\dev\open-clipper."
}

# ---- 1. Tools -------------------------------------------------------------------------------

Step "Checking Visual Studio C++ Build Tools"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
function Find-VsWithCpp {
  if (-not (Test-Path $vswhere)) { return $null }
  & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
$vsPath = Find-VsWithCpp
if (-not $vsPath) {
  Write-Host "Installing Visual Studio 2022 Build Tools with C++ (about 10-20 minutes, a few GB)..."
  Winget-Install "Microsoft.VisualStudio.2022.BuildTools" @(
    "--override",
    "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  )
  $vsPath = Find-VsWithCpp
  if (-not $vsPath) { throw "Visual Studio C++ Build Tools did not install. Install them manually (Desktop development with C++) and re-run." }
}
Write-Host "Using Visual Studio at $vsPath"

Step "Checking Git, Node.js, Rust$(if ($GpuSpeech) { ', CMake' })"
if (-not (Has "git")) { Winget-Install "Git.Git" }
$nodeMajor = if (Has "node") { [int]((node --version) -replace '^v(\d+).*', '$1') } else { 0 }
if ($nodeMajor -lt 24) { Winget-Install "OpenJS.NodeJS.LTS" }
if (-not (Has "rustup")) { Winget-Install "Rustlang.Rustup" }
if ($GpuSpeech -and -not (Has "cmake")) { Winget-Install "Kitware.CMake" }
foreach ($tool in @("git", "node", "npm", "rustup")) {
  if (-not (Has $tool)) { throw "$tool is still not available. Close this window, open a new PowerShell and re-run the script." }
}
Invoke-Checked "rustup" { rustup default stable }
Invoke-Checked "rustup update" { rustup update stable --no-self-update }

# The C++ compiler and linker are only on PATH inside a VS developer shell.
Step "Entering the Visual Studio developer environment"
Import-Module (Join-Path $vsPath "Common7\Tools\Microsoft.VisualStudio.DevShell.dll")
Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation -DevCmdArguments "-arch=x64 -host_arch=x64" | Out-Null
Set-Location $ProjectRoot
# Keep the dev shell's PATH (compiler, linker); only make sure cargo is on it.
if (-not (Has "cargo")) { $env:Path = "$env:Path;$env:USERPROFILE\.cargo\bin" }
# .cargo\config.toml pins the original developer's exact link.exe path; use the one on PATH.
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = "link.exe"

# ---- 2. FFmpeg ------------------------------------------------------------------------------

Step "Static FFmpeg 8.1 (vcpkg $VcpkgTag)"
$vcpkgExe = Join-Path $VcpkgRoot "vcpkg.exe"
$ffmpegInfo = Get-ChildItem -Path (Join-Path $VcpkgRoot "installed\vcpkg\info") -Filter "ffmpeg_*_x64-windows-static.list" -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ((Test-Path $FfmpegLib) -and $ffmpegInfo -and $ffmpegInfo.Name -match $FfmpegVersionPattern) {
  Write-Host "Already built ($($ffmpegInfo.BaseName))."
} else {
  if (-not (Test-Path (Join-Path $VcpkgRoot ".git"))) {
    New-Item -ItemType Directory -Force -Path $VcpkgRoot | Out-Null
    Invoke-Checked "Creating the vcpkg folder" { git -C $VcpkgRoot init -q }
    Invoke-Checked "Adding the vcpkg remote" { git -C $VcpkgRoot remote add origin https://github.com/microsoft/vcpkg.git }
  }
  Invoke-Checked "Fetching vcpkg $VcpkgTag" { git -C $VcpkgRoot fetch -q --depth 1 origin "refs/tags/${VcpkgTag}:refs/tags/$VcpkgTag" }
  Invoke-Checked "Checking out vcpkg $VcpkgTag" { git -C $VcpkgRoot checkout -q -f $VcpkgTag }
  Invoke-Checked "Bootstrapping vcpkg" { & (Join-Path $VcpkgRoot "bootstrap-vcpkg.bat") -disableMetrics }
  if ($ffmpegInfo) {
    Write-Host "Replacing $($ffmpegInfo.BaseName) with FFmpeg 8.1..."
    Invoke-Checked "Removing the old FFmpeg" { & $vcpkgExe remove "ffmpeg:x64-windows-static" --recurse }
  }
  Write-Host "Compiling FFmpeg. This is the slow part (roughly 20-60 minutes)..."
  Invoke-Checked "Building FFmpeg" { & $vcpkgExe install "ffmpeg:x64-windows-static" }
  if (-not (Test-Path $FfmpegLib)) { throw "FFmpeg finished but $FfmpegLib is missing." }
}

# ---- 3. Speech library ----------------------------------------------------------------------

$cargoConfig = Join-Path $ProjectRoot "src-tauri\.cargo\config.toml"
$configText = Get-Content $cargoConfig -Raw
if ($GpuSpeech) {
  Step "GPU (DirectML) speech library"
  $configText = $configText -replace '(?m)^#\s*(SHERPA_ONNX_LIB_DIR\s*=)', '$1'
  Set-Content -Path $cargoConfig -Value $configText -NoNewline
  if (Test-Path (Join-Path $ProjectRoot "third_party\sherpa-onnx-directml\install\lib\sherpa-onnx-c-api.lib")) {
    Write-Host "Already built."
  } else {
    Invoke-Checked "Building the DirectML speech library" {
      powershell -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\models\build-sherpa-directml.ps1")
    }
  }
} else {
  Step "Speech library: using CPU prebuilds (pass -GpuSpeech for DirectML)"
  # Without SHERPA_ONNX_LIB_DIR, sherpa-onnx downloads its CPU prebuilds during the build.
  $configText = $configText -replace '(?m)^(SHERPA_ONNX_LIB_DIR\s*=)', '# $1'
  Set-Content -Path $cargoConfig -Value $configText -NoNewline
}

# ---- 4. ONNX Runtime for vocals isolation ---------------------------------------------------

Step "ONNX Runtime $OrtVersion (DirectML) for vocals isolation"
$ortDll = Join-Path $OrtDir "runtimes\win-x64\native\onnxruntime.dll"
if (-not (Test-Path $ortDll)) {
  Expand-NuGet "Microsoft.ML.OnnxRuntime.DirectML" $OrtVersion $OrtDir
}
if (-not (Test-Path $ortDll)) { throw "onnxruntime.dll not found at $ortDll after download." }

# DirectML.dll comes from the package's Microsoft.AI.DirectML dependency.
$directMlDll = Get-ChildItem -Path (Join-Path $ProjectRoot "third_party") -Recurse -Filter "DirectML.dll" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
if (-not $directMlDll) {
  $nuspec = Get-ChildItem -Path $OrtDir -Filter "*.nuspec" | Select-Object -First 1
  $dmlVersion = ([xml](Get-Content $nuspec.FullName)).package.metadata.dependencies.SelectNodes("//*[local-name()='dependency']") |
    Where-Object { $_.id -eq "Microsoft.AI.DirectML" } | Select-Object -First 1 -ExpandProperty version
  $dmlVersion = ($dmlVersion -replace '[\[\]\(\) ]', '').Split(',')[0]
  if (-not $dmlVersion) { throw "Could not work out the Microsoft.AI.DirectML version from $($nuspec.Name)." }
  Write-Host "Downloading Microsoft.AI.DirectML $dmlVersion"
  Expand-NuGet "Microsoft.AI.DirectML" $dmlVersion (Join-Path $ProjectRoot "third_party\directml\$dmlVersion")
  $directMlDll = Get-ChildItem -Path (Join-Path $ProjectRoot "third_party\directml") -Recurse -Filter "DirectML.dll" |
    Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
  if (-not $directMlDll) { throw "DirectML.dll not found in the Microsoft.AI.DirectML package." }
}

# The app bundles resources\win-runtime\*.dll; give that folder the runtime DLLs it needs.
New-Item -ItemType Directory -Force -Path $WinRuntimeDir | Out-Null
Copy-Item $directMlDll.FullName $WinRuntimeDir -Force
$providersShared = Join-Path $OrtDir "runtimes\win-x64\native\onnxruntime_providers_shared.dll"
if (Test-Path $providersShared) { Copy-Item $providersShared $WinRuntimeDir -Force }

# ---- 5. Build -------------------------------------------------------------------------------

Step "Installing JavaScript packages"
Invoke-Checked "npm install" { npm install --no-fund --no-audit }
if (-not (Test-Path (Join-Path $ProjectRoot ".env"))) {
  Copy-Item (Join-Path $ProjectRoot ".env.example") (Join-Path $ProjectRoot ".env")
}

Step "Building open-clipper.exe (first time: about 10-25 minutes)"
# Same settings as `npm run tauri:build:fast`, but with an absolute CARGO_TARGET_DIR: the
# sherpa-onnx CPU prebuild download resolves a relative target dir from its own crate folder,
# so the linker could not find sherpa-onnx-c-api.lib.
$env:CARGO_TARGET_DIR = Join-Path $ProjectRoot "src-tauri\target-fast"
$env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "256"
$env:CARGO_PROFILE_RELEASE_LTO = "off"
$env:CARGO_PROFILE_RELEASE_INCREMENTAL = "true"
$env:CARGO_PROFILE_RELEASE_OPT_LEVEL = "2"
$env:CARGO_PROFILE_RELEASE_STRIP = "none"
# sherpa-onnx-sys only re-runs its build script when SHERPA_* variables change, so output from
# an earlier build with a relative CARGO_TARGET_DIR (e.g. `npm run tauri:build:fast`) keeps the
# broken relative link path. Delete such stale output so it is regenerated.
Get-ChildItem -Path (Join-Path $env:CARGO_TARGET_DIR "release\build") -Directory -Filter "sherpa-onnx-sys-*" -ErrorAction SilentlyContinue |
  Where-Object {
    $output = Join-Path $_.FullName "output"
    (Test-Path $output) -and (Select-String -Path $output -Pattern 'rustc-link-search=native=(?![A-Za-z]:)' -Quiet)
  } |
  ForEach-Object {
    Write-Host "Removing stale sherpa-onnx build output: $($_.Name)"
    Remove-Item -Recurse -Force $_.FullName
    # Drop the matching fingerprints too, so Cargo re-runs the build script instead of replaying it.
    Get-ChildItem -Path (Join-Path $env:CARGO_TARGET_DIR "release\.fingerprint") -Directory -Filter "sherpa-onnx-sys-*" -ErrorAction SilentlyContinue |
      Remove-Item -Recurse -Force
  }
Invoke-Checked "The app build" { node (Join-Path $ProjectRoot "scripts\run-tauri.mjs") build --no-bundle }

# Make sure every runtime DLL sits next to the exe.
Copy-Item (Join-Path $WinRuntimeDir "*.dll") $ReleaseDir -Force
if (-not (Test-Path (Join-Path $ReleaseDir "sherpa-onnx-c-api.dll"))) {
  $targetDir = Join-Path $ProjectRoot "src-tauri\target-fast"
  Get-ChildItem -Path $targetDir -Recurse -Include "sherpa-onnx-c-api.dll", "onnxruntime.dll" -ErrorAction SilentlyContinue |
    Where-Object { $_.DirectoryName -ne $ReleaseDir } |
    Sort-Object Name -Unique |
    ForEach-Object { Copy-Item $_.FullName $ReleaseDir -Force }
}

$exe = Join-Path $ReleaseDir "open-clipper.exe"
if (-not (Test-Path $exe)) { throw "The build finished but $exe is missing." }

Step "Done in $([int]((Get-Date) - $Started).TotalMinutes) minutes"
Write-Host "Your app: $exe" -ForegroundColor Green
Write-Host "Run it from that folder (it needs the DLLs and models beside it)."
if (-not $NoLaunch) {
  Write-Host "Starting it now..."
  Start-Process -FilePath $exe -WorkingDirectory $ReleaseDir
}
