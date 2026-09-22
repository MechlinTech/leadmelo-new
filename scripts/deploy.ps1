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

docker compose --env-file $envFile -p $project -f docker-compose.selfhosted.yml up -d --build
docker compose --env-file $envFile -p $project -f docker-compose.selfhosted.yml ps

$health = "http://127.0.0.1:$($env:HOST_PORT)/api/health"
$deadline = (Get-Date).AddMinutes(3)
do {
  try {
    $response = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) {
      Write-Host "Healthy at $health"
      exit 0
    }
  } catch {
    Start-Sleep -Seconds 5
  }
} while ((Get-Date) -lt $deadline)

throw "Timed out waiting for $health"
