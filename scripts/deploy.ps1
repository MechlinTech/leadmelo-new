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

# Print the container's own output. Without this a failing migrate is just an exit code.
function Show-Logs([string[]]$ComposeArgs) {
  $pref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & docker @compose @ComposeArgs 2>&1 | ForEach-Object { Write-Host $_ } } finally { $ErrorActionPreference = $pref }
}

# Leave the existing database volume running. Recreate only the app containers so the new image replaces what is listening.
Invoke-Compose @('up', '-d', '--build', '--no-recreate', 'postgres')

# Wait for postgres to accept connections. `--no-deps` below skips compose's own wait, so without this a
# freshly started database races the migration and migrate dies on a refused connection.
$pgDeadline = [datetimeoffset]::UtcNow.AddMinutes(5)
do {
  $pgHealth = docker inspect "${project}-postgres-1" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
  if ($LASTEXITCODE -ne 0) { throw "could not inspect ${project}-postgres-1" }
  if ($pgHealth -eq 'healthy') { break }
  if ($pgHealth -eq 'unhealthy') {
    Show-Logs @('logs', '--tail', '100', 'postgres')
    throw "postgres is unhealthy"
  }
  Start-Sleep -Seconds 2
} while ([datetimeoffset]::UtcNow -lt $pgDeadline)
if ($pgHealth -ne 'healthy') { Show-Logs @('logs', '--tail', '100', 'postgres'); throw "postgres did not become healthy" }

Invoke-Compose @('up', '-d', '--build', '--force-recreate', '--no-deps', 'migrate')

$migrateDeadline = [datetimeoffset]::UtcNow.AddMinutes(5)
do {
  $migrateState = docker inspect "${project}-migrate-1" --format '{{.State.Status}} {{.State.ExitCode}}'
  if ($LASTEXITCODE -ne 0) { throw "could not inspect ${project}-migrate-1" }
  if ($migrateState -match '^exited (\d+)$') {
    if ($Matches[1] -ne '0') {
      Show-Logs @('logs', '--no-color', '--tail', '200', 'migrate')
      throw "migrate exited $($Matches[1]). The previous web container was left in place."
    }
    break
  }
  Start-Sleep -Seconds 2
} while ([datetimeoffset]::UtcNow -lt $migrateDeadline)
if ($migrateState -notmatch '^exited 0$') {
  Show-Logs @('logs', '--no-color', '--tail', '200', 'migrate')
  throw "migrate did not finish (last state: $migrateState)"
}

Invoke-Compose @('up', '-d', '--build', '--force-recreate', '--no-deps', 'web', 'worker')

# The gateway lives behind the optional "gateway" profile, which a plain `up web worker` never starts.
# That left the web container resolving PROVIDER_GATEWAY_URL to a hostname with no container behind
# it, so saving a bearer token reported "the gateway could not be reached" even though the operator
# had configured it. When the deployment names a gateway, start it as part of the same release.
# Skipped when PROVIDER_GATEWAY_URL is empty, which is how a deployment says it uses no gateway.
if ($env:PROVIDER_GATEWAY_URL -and $env:PROVIDER_GATEWAY_URL.Trim()) {
  Invoke-Compose @('--profile', 'gateway', 'up', '-d', '--build', '--force-recreate', '--no-deps', 'gateway')
  # /health is unauthenticated, so this proves the service is actually answering before anyone
  # spends a round trip finding out from a failed credential save.
  $gwDeadline = [datetimeoffset]::UtcNow.AddMinutes(2)
  do {
    $gwHealth = docker inspect "${project}-gateway-1" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $gwHealth -eq 'healthy') { break }
    if ($gwHealth -eq 'unhealthy' -or $gwHealth -eq 'exited') { Show-Logs @('logs', '--tail', '100', 'gateway'); throw "gateway is $gwHealth" }
    Start-Sleep -Seconds 2
  } while ([datetimeoffset]::UtcNow -lt $gwDeadline)
  if ($gwHealth -ne 'healthy') { Show-Logs @('logs', '--tail', '100', 'gateway'); throw "gateway did not become healthy (last state: $gwHealth)" }
}

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

# A generated .env.prod can silently lose a variable: an empty value in the host env file is dropped
# rather than written, and compose then substitutes its own default (empty for this one). The result
# was a healthy-looking deployment in which no credential save could ever reach the gateway. Refuse
# to deploy with an unset value rather than shipping that.
if (-not $env:PROVIDER_GATEWAY_URL -or -not $env:PROVIDER_GATEWAY_URL.Trim()) {
  if ($env:LEADMELO_NO_GATEWAY -notmatch '^(1|true|yes|on)$') {
    throw "PROVIDER_GATEWAY_URL is empty in $envFile. Set it (for the bundled gateway: http://gateway:8788), or set LEADMELO_NO_GATEWAY=1 if this deployment runs no gateway. Without it every provider credential save reports the gateway as unreachable."
  }
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
