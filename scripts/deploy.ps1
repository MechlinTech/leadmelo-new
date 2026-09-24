param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dev', 'production')]
  [string]$Environment
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$envFile = if ($Environment -eq 'production') { '.env.prod' } else { '.env.dev' }
$example = if ($Environment -eq 'production') { '.env.prod.example' } else { '.env.dev.example' }
$project = if ($Environment -eq 'production') { 'leadmelo-prod' } else { 'leadmelo-dev' }

if (-not (Test-Path $envFile)) {
  throw "Missing $envFile. Copy $example, replace CHANGE_ME values, and keep the file off git."
}

$raw = Get-Content $envFile -Raw
if ($raw -match 'CHANGE_ME') { throw "$envFile still contains CHANGE_ME placeholders" }

Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $name, $value = $_.Split('=', 2)
  if ($name -and $value) { Set-Item -Path "Env:$name" -Value $value.Trim() }
}

foreach ($key in @('POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'SESSION_SECRET')) {
  $val = (Get-Item "Env:$key").Value
  if ($val -notmatch '^[a-fA-F0-9]{64}$') { throw "$key must be 64 hex characters" }
}

if (-not $env:HOST_PORT) { $env:HOST_PORT = if ($Environment -eq 'production') { '7677' } else { '7676' } }
if ($env:COMPOSE_PROJECT_NAME) { $project = $env:COMPOSE_PROJECT_NAME }

if (-not $env:RELEASE_TAG) { throw "$envFile is missing RELEASE_TAG" }
$expectedImage = "leadmelo:$($env:RELEASE_TAG)"
$deployStarted = [datetimeoffset]::UtcNow
$compose = @('compose', '--env-file', $envFile, '-p', $project, '-f', 'docker-compose.selfhosted.yml')

function Invoke-Compose([string[]]$ComposeArgs) {
  # Windows PowerShell turns native stderr into a terminating error when ErrorActionPreference is Stop.
  $pref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & docker @compose @ComposeArgs
    if ($LASTEXITCODE -ne 0) { throw "docker compose $($ComposeArgs -join ' ') failed (exit $LASTEXITCODE)" }
  } finally {
    $ErrorActionPreference = $pref
  }
}

# Leave the existing database volume running. Recreate only the app containers so the new image replaces what is listening.
Invoke-Compose @('up', '-d', '--build', '--no-recreate', 'postgres')
Invoke-Compose @('up', '-d', '--build', '--force-recreate', '--no-deps', 'migrate')

$migrateDeadline = [datetimeoffset]::UtcNow.AddMinutes(5)
do {
  $migrateState = docker inspect "${project}-migrate-1" --format '{{.State.Status}} {{.State.ExitCode}}'
  if ($LASTEXITCODE -ne 0) { throw "could not inspect ${project}-migrate-1" }
  if ($migrateState -match '^exited (\d+)$') {
    if ($Matches[1] -ne '0') { throw "migrate exited $($Matches[1]). The previous web container was left in place." }
    break
  }
  Start-Sleep -Seconds 2
} while ([datetimeoffset]::UtcNow -lt $migrateDeadline)
if ($migrateState -notmatch '^exited 0$') { throw "migrate did not finish" }

Invoke-Compose @('up', '-d', '--build', '--force-recreate', '--no-deps', 'web', 'worker')
Invoke-Compose @('ps')

$runningImage = docker inspect "${project}-web-1" --format '{{.Config.Image}}'
if ($LASTEXITCODE -ne 0) { throw "could not inspect ${project}-web-1" }
if ($runningImage -ne $expectedImage) {
  throw "web container is running $runningImage, expected $expectedImage. Port $($env:HOST_PORT) is still serving the previous release."
}
$createdRaw = docker inspect "${project}-web-1" --format '{{.Created}}'
# Docker emits nanoseconds. Windows PowerShell parses at most seven fractional digits.
$created = [datetimeoffset]::Parse(($createdRaw -replace '(\.\d{7})\d+', '$1'))
if ($created -lt $deployStarted.AddSeconds(-15)) {
  throw "web container was not recreated for $expectedImage (created $createdRaw)"
}

$health = "http://127.0.0.1:$($env:HOST_PORT)/api/health"
$deadline = [datetimeoffset]::UtcNow.AddMinutes(3)
do {
  try {
    $response = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) {
      Write-Host "Healthy at $health on $expectedImage"
      exit 0
    }
  } catch {
    Start-Sleep -Seconds 5
  }
} while ([datetimeoffset]::UtcNow -lt $deadline)

throw "Timed out waiting for $health on $expectedImage"
