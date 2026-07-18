#!/usr/bin/env pwsh
param(
    [Parameter(Mandatory = $true)]
    [string] $RepoRoot
)

$ErrorActionPreference = "Stop"
$rawSecrets = dotnet user-secrets list --json --project "$RepoRoot/src/Api"
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$secrets = ($rawSecrets | Where-Object { $_ -notmatch "^//" }) | ConvertFrom-Json
$connectionString = $secrets.'globalSettings:sqlServer:connectionString'
if ([string]::IsNullOrWhiteSpace($connectionString)) {
    throw "MSSQL connection string is missing from the isolated user-secret store"
}

dotnet run --no-build --no-restore --project "$RepoRoot/util/MsSqlMigratorUtility" -- $connectionString
exit $LASTEXITCODE
