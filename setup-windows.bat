@echo off
setlocal EnableExtensions
title LeadMelo Windows setup

rem One-file setup for a new Windows host:
rem   1) Git + Docker Desktop (Linux containers)
rem   2) .env.dev / .env.prod and both Compose stacks (7676 + 7677)
rem   3) GitHub runners leadmelo-dev and leadmelo-prod
rem
rem Right-click -> Run as administrator, or just double-click (it will elevate).
rem Optional flags: /SkipDeploy  /SkipRunners  /SkipSeed
rem Optional env:   LEADMELO_REPO  LEADMELO_DIR  LEADMELO_GH_TOKEN
rem                 LEADMELO_RUNNER_DEV_TOKEN  LEADMELO_RUNNER_PROD_TOKEN
rem                 LEADMELO_SEED_PASSWORD
rem
rem If this host will take CI deploys, copy the existing .env.dev and .env.prod
rem next to this file first so GitHub Environment secrets stay in sync.

set "LEADMELO_SETUP_BAT=%~f0"
set "LEADMELO_SETUP_DIR=%~dp0"
set "LEADMELO_SETUP_ARGS=%*"

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting Administrator rights...
  powershell -NoProfile -Command "Start-Process -LiteralPath '%LEADMELO_SETUP_BAT%' -Verb RunAs"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p=$env:LEADMELO_SETUP_BAT; $c=Get-Content -LiteralPath $p; $m=$c | Select-String -SimpleMatch '___LEADMELO_PS1___' | Select-Object -Last 1; if(-not $m){ throw 'setup script marker missing' }; Invoke-Expression (($c | Select-Object -Skip $m.LineNumber) -join [Environment]::NewLine)"
set "ERR=%ERRORLEVEL%"
echo.
pause
exit /b %ERR%

___LEADMELO_PS1___
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

function Test-Flag([string]$Name) {
  return ($env:LEADMELO_SETUP_ARGS -split '\s+' | Where-Object { $_ -ieq $Name }).Count -gt 0
}

function New-RandomBytes([int]$Count) {
  $bytes = New-Object byte[] $Count
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  return $bytes
}

function New-HexSecret { return -join ((New-RandomBytes 32) | ForEach-Object { $_.ToString('x2') }) }
function New-B64Secret { return [Convert]::ToBase64String((New-RandomBytes 32)) }

function Protect-SecretFile([string]$Path) {
  icacls.exe $Path /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null
}

function Get-CommandPath([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallbacks = @{
    git = @(
      "$env:ProgramFiles\Git\cmd\git.exe",
      "${env:ProgramFiles(x86)}\Git\cmd\git.exe"
    )
    docker = @(
      "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe"
    )
    winget = @(
      "$env:LocalAppData\Microsoft\WindowsApps\winget.exe"
    )
  }
  foreach ($candidate in @($fallbacks[$Name])) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Install-WingetPackage([string]$PackageId) {
  $winget = Get-CommandPath 'winget'
  if (-not $winget) { throw "winget is not installed. Install Git and Docker Desktop, then re-run this script." }
  Write-Host "    Installing $PackageId ..."
  & $winget install --id $PackageId -e --accept-package-agreements --accept-source-agreements --disable-interactivity
  # 0 = installed; -1978335189 / -1978335135 = already present / no upgrade
  if ($LASTEXITCODE -notin @(0, -1978335189, -1978335135)) {
    throw "winget failed to install $PackageId (exit $LASTEXITCODE)."
  }
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Ensure-Git {
  Write-Step 'Git for Windows'
  if (Get-CommandPath 'git') { Write-Ok 'Git is already installed.'; return }
  Install-WingetPackage 'Git.Git'
  Refresh-Path
  if (-not (Get-CommandPath 'git')) { throw 'Git installed but is not on PATH. Open a new elevated prompt and re-run.' }
  Write-Ok 'Git installed.'
}

function Ensure-Docker {
  Write-Step 'Docker Desktop (Linux containers)'
  $dockerDesktop = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  $dockerCli = "$env:ProgramFiles\Docker\Docker\DockerCli.exe"
  if (-not (Get-CommandPath 'docker')) {
    Install-WingetPackage 'Docker.DockerDesktop'
    Refresh-Path
  } else {
    Write-Ok 'Docker CLI is already installed.'
  }

  try { net localgroup docker-users $env:USERNAME /add 2>$null | Out-Null } catch { }

  if (Test-Path -LiteralPath $dockerDesktop) {
    $running = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue
    if (-not $running) {
      Write-Host '    Starting Docker Desktop...'
      Start-Process -LiteralPath $dockerDesktop
    }
  }

  if (Test-Path -LiteralPath $dockerCli) {
    try { & $dockerCli -SwitchLinuxEngine 2>$null } catch { }
  }

  $deadline = (Get-Date).AddMinutes(10)
  do {
    Refresh-Path
    $docker = Get-CommandPath 'docker'
    if ($docker) {
      try {
        # Windows PowerShell turns native stderr into a terminating error when
        # ErrorActionPreference is Stop. docker info warns on stderr even when healthy.
        $pref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & $docker info 2>$null | Out-Null } finally { $ErrorActionPreference = $pref }
        if ($LASTEXITCODE -eq 0) {
          Write-Ok 'Docker engine is ready.'
          return
        }
      } catch { }
    }
    Start-Sleep -Seconds 8
    Write-Host '    Waiting for Docker engine...'
  } while ((Get-Date) -lt $deadline)

  throw 'Docker did not become ready. Open Docker Desktop, finish first-run, then re-run this script.'
}

function Resolve-RepoRoot {
  Write-Step 'Repository'
  $here = $env:LEADMELO_SETUP_DIR.TrimEnd('\')
  if ((Test-Path -LiteralPath (Join-Path $here 'docker-compose.selfhosted.yml')) -and (Test-Path -LiteralPath (Join-Path $here 'scripts\deploy.ps1'))) {
    Write-Ok "Using existing tree: $here"
    return $here
  }

  $repoUrl = if ($env:LEADMELO_REPO) { $env:LEADMELO_REPO } else { 'https://github.com/MechlinTech/leadmelo-new.git' }
  $dest = if ($env:LEADMELO_DIR) { $env:LEADMELO_DIR } else { 'C:\leadmelo' }
  $git = Get-CommandPath 'git'

  if (Test-Path -LiteralPath (Join-Path $dest 'docker-compose.selfhosted.yml')) {
    Write-Ok "Using $dest"
    return $dest
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Write-Host "    Cloning $repoUrl -> $dest"
  $token = $env:LEADMELO_GH_TOKEN
  if ($token -and $repoUrl -match '^https://github.com/(.+)$') {
    $cloneUrl = "https://x-access-token:${token}@github.com/$($Matches[1])"
    & $git clone --config core.longpaths=true $cloneUrl $dest
  } else {
    & $git clone --config core.longpaths=true $repoUrl $dest
  }
  if ($LASTEXITCODE -ne 0) { throw 'git clone failed. For a private repo set LEADMELO_GH_TOKEN or clone the repo yourself and run this script from it.' }
  Write-Ok "Cloned to $dest"
  return $dest
}

function Read-EnvFile([string]$Path) {
  $map = [ordered]@{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $name, $value = $line.Split('=', 2)
    if ($name) { $map[$name.Trim()] = $value }
  }
  return $map
}

function Write-EnvFile([string]$Path, $Map) {
  $lines = foreach ($key in $Map.Keys) { "$key=$($Map[$key])" }
  [System.IO.File]::WriteAllText($Path, (($lines -join "`r`n") + "`r`n"), [System.Text.UTF8Encoding]::new($false))
}

function Build-EnvMap([string]$Kind, [string]$ExistingPath, [string]$ExamplePath) {
  $map = Read-EnvFile $ExamplePath
  $existing = Read-EnvFile $ExistingPath
  foreach ($key in @($existing.Keys)) { $map[$key] = $existing[$key] }

  if ($Kind -eq 'dev') {
    $map['APP_URL'] = if ($map['APP_URL'] -and $map['APP_URL'] -notmatch 'CHANGE_ME') { $map['APP_URL'] } else { 'http://127.0.0.1:7676' }
    $map['HOST_PORT'] = '7676'
    $map['COMPOSE_PROJECT_NAME'] = 'leadmelo-dev'
    $map['POSTGRES_DB'] = 'leadmelo_dev'
  } else {
    $map['APP_URL'] = if ($map['APP_URL'] -and $map['APP_URL'] -notmatch 'CHANGE_ME') { $map['APP_URL'] } else { 'http://127.0.0.1:7677' }
    $map['HOST_PORT'] = '7677'
    $map['COMPOSE_PROJECT_NAME'] = 'leadmelo-prod'
    $map['POSTGRES_DB'] = 'leadmelo_prod'
  }

  $map['NODE_ENV'] = 'production'
  $map['RELEASE_TAG'] = if ($map['RELEASE_TAG']) { $map['RELEASE_TAG'] } else { '20.0.0' }
  $map['OUTBOUND_ENABLED'] = if ($map['OUTBOUND_ENABLED']) { $map['OUTBOUND_ENABLED'] } else { 'false' }
  $generated = $false
  foreach ($key in @('POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'SESSION_SECRET')) {
    if (-not $map[$key] -or $map[$key] -eq 'CHANGE_ME') {
      $map[$key] = New-HexSecret
      $generated = $true
    }
  }
  if (-not $map['DATA_ENCRYPTION_KEY'] -or $map['DATA_ENCRYPTION_KEY'] -eq 'CHANGE_ME') {
    $map['DATA_ENCRYPTION_KEY'] = New-B64Secret
    $generated = $true
  }
  $map['DATABASE_URL'] = "postgresql://leadmelo_app:$($map['APP_DB_PASSWORD'])@postgres:5432/$($map['POSTGRES_DB'])"
  return @{ Map = $map; Generated = $generated }
}

function Save-SecretsNote([string]$Root, $Dev, $Prod, [bool]$Generated) {
  if (-not $Generated) { return }
  $noteDir = Join-Path $env:USERPROFILE 'LeadMelo'
  New-Item -ItemType Directory -Force -Path $noteDir | Out-Null
  $note = Join-Path $noteDir 'generated-secrets.txt'
  $body = @"
LeadMelo secrets generated $(Get-Date -Format o)
Keep this file off git. Paste the same values into GitHub Environments
(Settings -> Environments -> development / production) BEFORE the next CI deploy.
If CI secrets differ from these files, the next deploy will rewrite .env and
PostgreSQL on this machine will reject the new password.

--- development (.env.dev) ---
POSTGRES_PASSWORD=$($Dev.POSTGRES_PASSWORD)
APP_DB_PASSWORD=$($Dev.APP_DB_PASSWORD)
SESSION_SECRET=$($Dev.SESSION_SECRET)
DATA_ENCRYPTION_KEY=$($Dev.DATA_ENCRYPTION_KEY)

--- production (.env.prod) ---
POSTGRES_PASSWORD=$($Prod.POSTGRES_PASSWORD)
APP_DB_PASSWORD=$($Prod.APP_DB_PASSWORD)
SESSION_SECRET=$($Prod.SESSION_SECRET)
DATA_ENCRYPTION_KEY=$($Prod.DATA_ENCRYPTION_KEY)
"@
  [System.IO.File]::WriteAllText($note, $body, [System.Text.UTF8Encoding]::new($false))
  Protect-SecretFile $note
  Write-Warn "New secrets written to $note"
  Write-Warn 'Copy them into GitHub Environments if this host will run Actions deploys.'
}

function Ensure-EnvFiles([string]$Root) {
  Write-Step 'Environment files'
  $copied = $false
  foreach ($name in @('.env.dev', '.env.prod')) {
    $src = Join-Path $env:LEADMELO_SETUP_DIR $name
    $dst = Join-Path $Root $name
    if ((Test-Path -LiteralPath $src) -and -not (Test-Path -LiteralPath $dst)) {
      Copy-Item -LiteralPath $src -Destination $dst
      $copied = $true
    }
  }
  if ($copied) { Write-Ok 'Copied .env files from the setup folder.' }

  $dev = Build-EnvMap 'dev' (Join-Path $Root '.env.dev') (Join-Path $Root '.env.dev.example')
  $prod = Build-EnvMap 'prod' (Join-Path $Root '.env.prod') (Join-Path $Root '.env.prod.example')
  Write-EnvFile (Join-Path $Root '.env.dev') $dev.Map
  Write-EnvFile (Join-Path $Root '.env.prod') $prod.Map
  Protect-SecretFile (Join-Path $Root '.env.dev')
  Protect-SecretFile (Join-Path $Root '.env.prod')
  Save-SecretsNote $Root $dev.Map $prod.Map ($dev.Generated -or $prod.Generated)
  Write-Ok '.env.dev and .env.prod are ready.'
}

function Invoke-Deploy([string]$Root, [string]$Environment) {
  Write-Step "Deploy $Environment"
  $script = Join-Path $Root 'scripts\deploy.ps1'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Environment $Environment
  if ($LASTEXITCODE -ne 0) { throw "deploy.ps1 $Environment failed (exit $LASTEXITCODE)" }
}

function Invoke-Seed([string]$Root) {
  if (Test-Flag '/SkipSeed') { return }
  $password = $env:LEADMELO_SEED_PASSWORD
  if (-not $password) {
    Write-Host ""
    $secure = Read-Host "Seed Mechlin accounts on both DBs (16+ chars, blank to skip)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
  if (-not $password) { Write-Warn 'Seed skipped.'; return }
  if ($password.Length -lt 16) { throw 'SEED password must be at least 16 characters.' }

  $docker = Get-CommandPath 'docker'
  foreach ($item in @(
    @{ Env = '.env.dev'; Project = 'leadmelo-dev' },
    @{ Env = '.env.prod'; Project = 'leadmelo-prod' }
  )) {
    Write-Host "    Seeding $($item.Project) ..."
    $prev = $env:SEED_PASSWORD
    $env:SEED_PASSWORD = $password
    try {
      $pref = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        & $docker compose --env-file $item.Env -p $item.Project -f docker-compose.selfhosted.yml run --rm -e SEED_PASSWORD web node --import tsx scripts/seed-initial.ts
      } finally { $ErrorActionPreference = $pref }
      if ($LASTEXITCODE -ne 0) { throw "Seed failed for $($item.Project)" }
    } finally {
      if ($null -eq $prev) { Remove-Item Env:SEED_PASSWORD -ErrorAction SilentlyContinue } else { $env:SEED_PASSWORD = $prev }
    }
  }
  Write-Ok 'Seeded admin@ / manager@ / member@ / operator@mechlintech.com on both databases.'
}

function Get-GitHubToken {
  if ($env:LEADMELO_GH_TOKEN) { return $env:LEADMELO_GH_TOKEN }
  if ($env:GH_TOKEN) { return $env:GH_TOKEN }
  Write-Host ""
  Write-Host "GitHub PAT with Administration: Read and write on MechlinTech/leadmelo-new"
  Write-Host "(needed to register runners). Leave blank to paste two runner tokens instead."
  $secure = Read-Host "GitHub PAT" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Get-RegistrationToken([string]$Pat, [string]$Kind) {
  $envName = if ($Kind -eq 'dev') { 'LEADMELO_RUNNER_DEV_TOKEN' } else { 'LEADMELO_RUNNER_PROD_TOKEN' }
  $existingToken = [Environment]::GetEnvironmentVariable($envName)
  if ($existingToken) { return $existingToken }
  if ($Pat) {
    $uri = 'https://api.github.com/repos/MechlinTech/leadmelo-new/actions/runners/registration-token'
    $headers = @{
      Authorization = "Bearer $Pat"
      Accept = 'application/vnd.github+json'
      'User-Agent' = 'leadmelo-windows-setup'
    }
    $resp = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers
    if (-not $resp.token) { throw 'GitHub did not return a runner registration token.' }
    return [string]$resp.token
  }
  Write-Host ""
  Write-Host "Create a Windows runner token: GitHub -> Settings -> Actions -> Runners -> New self-hosted runner"
  $secure = Read-Host "Registration token for leadmelo-$Kind" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Get-RunnerZipUrl {
  try {
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/actions/runner/releases/latest' -Headers @{ 'User-Agent' = 'leadmelo-windows-setup' }
    $asset = $rel.assets | Where-Object { $_.name -like 'actions-runner-win-x64-*.zip' } | Select-Object -First 1
    if ($asset.browser_download_url) { return $asset.browser_download_url }
  } catch { }
  return 'https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-win-x64-2.337.0.zip'
}

function Ensure-RunnerLayout([string]$Dir) {
  if (Test-Path -LiteralPath (Join-Path $Dir 'config.cmd')) { return }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $url = Get-RunnerZipUrl
  $zip = Join-Path $Dir 'actions-runner-win-x64.zip'
  Write-Host "    Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $zip
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $Dir)
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
}

function Register-LogonTask([string]$Name, [string]$Dir) {
  $taskName = "LeadMelo-$Name"
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c run.cmd' -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
}

function Start-RunnerProcess([string]$Dir) {
  $needle = Join-Path $Dir 'bin\Runner.Listener.exe'
  $alive = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'Runner.Listener.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle.ToLower())
  }
  if ($alive) { Write-Ok "Already running from $Dir"; return }
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c run.cmd' -WorkingDirectory $Dir -WindowStyle Minimized
  Write-Ok "Started $Dir\run.cmd"
}

function Install-OneRunner([string]$Kind, [string]$Pat) {
  $name = "leadmelo-$Kind"
  $dir = "C:\actions-runner-$Kind"
  $label = $name
  Write-Step "GitHub runner $name"
  Ensure-RunnerLayout $dir

  if (-not (Test-Path -LiteralPath (Join-Path $dir '.runner'))) {
    $token = Get-RegistrationToken $Pat $Kind
    if (-not $token) { throw "No registration token for $name" }
    $winUser = "$env:USERDOMAIN\$env:USERNAME"
    $winPass = $env:LEADMELO_WINDOWS_PASSWORD
    $cfg = @(
      '--unattended',
      '--url', 'https://github.com/MechlinTech/leadmelo-new',
      '--token', $token,
      '--name', $name,
      '--labels', $label,
      '--work', '_work',
      '--replace'
    )
    if ($winPass) {
      $cfg += @('--runasservice', '--windowslogonaccount', $winUser, '--windowslogonpassword', $winPass)
    }
    $argLine = ($cfg | ForEach-Object { if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ } }) -join ' '
    $p = Start-Process -FilePath (Join-Path $dir 'config.cmd') -ArgumentList $argLine -WorkingDirectory $dir -Wait -PassThru -NoNewWindow
    if ($p.ExitCode -ne 0) { throw "config.cmd failed for $name (exit $($p.ExitCode))" }
    Write-Ok "Registered $name"
  } else {
    Write-Ok "$name is already configured."
  }

  $svcCmd = Join-Path $dir 'svc.cmd'
  $service = Get-Service | Where-Object { $_.Name -like "*$name*" -or $_.DisplayName -like "*$name*" } | Select-Object -First 1
  if ((Test-Path -LiteralPath $svcCmd) -and -not $service) {
    Start-Process -FilePath $svcCmd -ArgumentList 'install' -WorkingDirectory $dir -Wait -NoNewWindow
    Start-Process -FilePath $svcCmd -ArgumentList 'start' -WorkingDirectory $dir -Wait -NoNewWindow
    $service = Get-Service | Where-Object { $_.Name -like "*$name*" } | Select-Object -First 1
  }
  if ($service) {
    if ($service.Status -ne 'Running') { Start-Service $service.Name }
    Write-Ok "Service $($service.Name) is $($service.Status)"
  } else {
    Register-LogonTask $name $dir
    Start-RunnerProcess $dir
    Write-Warn "No Windows service for $name. It runs now and will restart at logon (task LeadMelo-$name)."
    Write-Warn "Docker Desktop needs an interactive login. To install a real service, set LEADMELO_WINDOWS_PASSWORD and re-run."
  }
}

# --- main ---
Write-Host 'LeadMelo Windows host setup'
Write-Host 'Dev  http://127.0.0.1:7676    Prod  http://127.0.0.1:7677'
Write-Host 'Runners: C:\actions-runner-dev  and  C:\actions-runner-prod'

$sys = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
if ($sys -and $sys.FreeSpace -lt 15GB) {
  Write-Warn ("C: has {0:N1} GB free. Docker images need ~10 GB. Free space if the build fails." -f ($sys.FreeSpace / 1GB))
}

Ensure-Git
Ensure-Docker
$root = Resolve-RepoRoot
Set-Location -LiteralPath $root
Ensure-EnvFiles $root

if (-not (Test-Flag '/SkipDeploy')) {
  Invoke-Deploy $root 'dev'
  Invoke-Deploy $root 'production'
  Invoke-Seed $root
} else {
  Write-Warn 'Deploy skipped.'
}

if (-not (Test-Flag '/SkipRunners')) {
  $pat = Get-GitHubToken
  Install-OneRunner 'dev' $pat
  Install-OneRunner 'prod' $pat
} else {
  Write-Warn 'Runners skipped.'
}

Write-Step 'Done'
Write-Host "    Dev   http://127.0.0.1:7676"
Write-Host "    Prod  http://127.0.0.1:7677"
Write-Host "    Confirm runners at GitHub -> Settings -> Actions -> Runners"
Write-Host "    Secrets note: $env:USERPROFILE\LeadMelo\generated-secrets.txt (only if new secrets were created)"
