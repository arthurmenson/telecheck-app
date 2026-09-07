param([Parameter(Mandatory=$true)][string]$RuntimeDirectory)
$Port = 56597
$ErrorActionPreference = 'Stop'
$taskNetworkRuntime = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$taskNetworkBin = Join-Path $taskNetworkRuntime 'postgresql-16.15/pgsql/bin'
$taskPinProfile = 'patient-session-refresh-author-v2'
$taskNetworkData = Join-Path $taskNetworkRuntime ('pgdata-' + $taskPinProfile)
$taskNetworkSettings = Get-Content -LiteralPath (Join-Path $taskNetworkRuntime 'local-secrets.json') -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath (Join-Path $taskNetworkData 'PG_VERSION'))) {
    $taskNetworkPasswordFile = Join-Path $taskNetworkRuntime ($taskPinProfile + '-initdb-password.tmp')
    try {
        [IO.File]::WriteAllText($taskNetworkPasswordFile, $taskNetworkSettings.postgresPassword)
        & (Join-Path $taskNetworkBin 'initdb.exe') -D $taskNetworkData -U postgres -E UTF8 --locale=C --auth=scram-sha-256 --pwfile=$taskNetworkPasswordFile
        if ($LASTEXITCODE -ne 0) { throw 'Network probe initialization failed' }
    } finally {
        if (Test-Path -LiteralPath $taskNetworkPasswordFile) { Remove-Item -LiteralPath $taskNetworkPasswordFile -Force }
    }
    @"
listen_addresses = '127.0.0.1'
port = $Port
max_connections = 50
shared_buffers = '64MB'
log_statement = 'none'
log_min_error_statement = 'panic'
"@ | Add-Content -LiteralPath (Join-Path $taskNetworkData 'postgresql.conf')
}
& (Join-Path $taskNetworkBin 'pg_ctl.exe') status -D $taskNetworkData
if ($LASTEXITCODE -ne 0) {
    Start-Process -FilePath (Join-Path $taskNetworkBin 'pg_ctl.exe') -ArgumentList @('start','-D',('"'+$taskNetworkData+'"'),'-l',('"'+(Join-Path $taskNetworkRuntime ('postgres-' + $taskPinProfile + '.log'))+'"'),'-w','-t','30') -WindowStyle Hidden
}
for ($taskNetworkAttempt=0; $taskNetworkAttempt -lt 30; $taskNetworkAttempt++) {
    & (Join-Path $taskNetworkBin 'pg_isready.exe') -h 127.0.0.1 -p $Port
    if ($LASTEXITCODE -eq 0) { exit 0 }
    Start-Sleep -Seconds 1
}
throw 'Network probe database is unavailable'
