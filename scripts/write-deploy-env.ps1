param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dev', 'production')]
  [string]$Environment,
  [Parameter(Mandatory = $true)]
  [string]$ReleaseTag
)

$ErrorActionPreference = 'Stop'

# C:\leadmelo holds the env files that already match this machine's databases.
# GitHub Environment secrets on this host do not. Those files win for passwords
# and APP_URL. RELEASE_TAG is always the commit being deployed.
$hostDir = 'C:\leadmelo'
$outName = if ($Environment -eq 'production') { '.env.prod' } else { '.env.dev' }
$hostFile = Join-Path $hostDir $outName

function Read-EnvFile([string]$Path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $name, $value = $line.Split('=', 2)
    $name = $name.Trim()
    if ($name) { $map[$name] = $value.Trim() }
  }
  return $map
}

if ($Environment -eq 'dev') {
  $map = [ordered]@{
    NODE_ENV = 'production'
    APP_URL = 'https://leadmelodev.mechlintech.com'
    HOST_PORT = '7676'
    COMPOSE_PROJECT_NAME = 'leadmelo-dev'
    POSTGRES_DB = 'leadmelo_dev'
  }
} else {
  $map = [ordered]@{
    NODE_ENV = 'production'
    APP_URL = 'https://leadmelo.mechlintech.com'
    HOST_PORT = '7677'
    COMPOSE_PROJECT_NAME = 'leadmelo-prod'
    POSTGRES_DB = 'leadmelo_prod'
  }
}

foreach ($key in @(
  'APP_URL', 'HOST_PORT', 'COMPOSE_PROJECT_NAME', 'POSTGRES_DB',
  'POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'SESSION_SECRET', 'DATA_ENCRYPTION_KEY',
  'PROVIDER_GATEWAY_URL', 'ALERT_WEBHOOK_URL', 'ALERT_WEBHOOK_SECRET',
  'PLATFORM_MAIL_TENANT_ID'
)) {
  $value = [Environment]::GetEnvironmentVariable($key)
  if ($value) { $map[$key] = $value.Trim() }
}

if ($Environment -eq 'dev' -and $map['APP_URL'] -match 'localhost|127\.0\.0\.1|^https://leadmelo\.mechlintech\.com/?$') {
  $map['APP_URL'] = 'https://leadmelodev.mechlintech.com'
}
if ($Environment -eq 'production' -and $map['APP_URL'] -match 'localhost|127\.0\.0\.1') {
  $map['APP_URL'] = 'https://leadmelo.mechlintech.com'
}

$hostEnv = Read-EnvFile $hostFile
foreach ($key in @(
  'APP_URL', 'HOST_PORT', 'COMPOSE_PROJECT_NAME', 'POSTGRES_DB',
  'POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'SESSION_SECRET', 'DATA_ENCRYPTION_KEY',
  'PROVIDER_GATEWAY_URL', 'ALERT_WEBHOOK_URL', 'ALERT_WEBHOOK_SECRET',
  'GATEWAY_CONFIG_DIR', 'GATEWAY_HOST_PORT', 'OUTBOUND_ENABLED', 'PLAN_ENFORCEMENT', 'SENDER_HEALTH_AUTO',
  'AI_ALLOWED_HOSTS', 'AI_DAILY_LIMIT', 'PLATFORM_MAIL_TENANT_ID'
)) {
  if ($hostEnv.Contains($key) -and $hostEnv[$key]) { $map[$key] = $hostEnv[$key] }
}

foreach ($key in @('POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'SESSION_SECRET', 'DATA_ENCRYPTION_KEY')) {
  if (-not $map[$key]) { throw "Missing $key. Add it to $hostFile or the GitHub Environment." }
}

$map['RELEASE_TAG'] = $ReleaseTag.Trim()
$map['NODE_ENV'] = 'production'

# The bundled gateway lives in this same compose project, so when one is configured its address is
# knowable without being told. Defaulting it here matters because an empty value is dropped from the
# generated file (see the copy loop above), which left the app with no PROVIDER_GATEWAY_URL at all:
# compose then passed an empty string, every credential save reported "the gateway could not be
# reached", and nothing named the missing variable. An operator who genuinely runs no gateway sets
# PROVIDER_GATEWAY_URL= explicitly, and this guard below lets them say so.
if (-not $map['PROVIDER_GATEWAY_URL']) {
  if ([Environment]::GetEnvironmentVariable('LEADMELO_NO_GATEWAY') -match '^(1|true|yes|on)$') {
    Write-Host 'PROVIDER_GATEWAY_URL not set and LEADMELO_NO_GATEWAY is on: deploying without the bundled gateway'
  } else {
    $map['PROVIDER_GATEWAY_URL'] = 'http://gateway:8788'
    Write-Host 'PROVIDER_GATEWAY_URL was not set; defaulting to the bundled gateway at http://gateway:8788'
  }
}
# Dev and prod share a machine, so the gateway's published host port must differ per deployment or
# the second one fails to bind. The in-network port stays 8788.
if (-not $map['GATEWAY_HOST_PORT']) { $map['GATEWAY_HOST_PORT'] = if ($Environment -eq 'production') { '8789' } else { '8788' } }
if (-not $map['GATEWAY_CONFIG_DIR']) { $map['GATEWAY_CONFIG_DIR'] = './gateway-config' }
if (-not $map['OUTBOUND_ENABLED']) { $map['OUTBOUND_ENABLED'] = 'false' }
if (-not $map['PLAN_ENFORCEMENT']) { $map['PLAN_ENFORCEMENT'] = 'off' }
if (-not $map['SENDER_HEALTH_AUTO']) { $map['SENDER_HEALTH_AUTO'] = 'on' }
$map['DATABASE_URL'] = "postgresql://leadmelo_app:$($map['APP_DB_PASSWORD'])@postgres:5432/$($map['POSTGRES_DB'])"

$lines = foreach ($key in $map.Keys) { "$key=$($map[$key])" }
$target = Join-Path (Get-Location) $outName
[System.IO.File]::WriteAllText($target, (($lines -join "`r`n") + "`r`n"), [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote $outName for $($map['APP_URL']) as $($map['RELEASE_TAG'])"
