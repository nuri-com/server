#!/usr/bin/env pwsh
param(
    [Parameter(Mandatory = $true)]
    [string] $RepoRoot,

    [Parameter(Mandatory = $true)]
    [string] $StateDir
)

$ErrorActionPreference = "Stop"

$secretsFile = Join-Path $RepoRoot "dev/secrets.json"
$ownershipMarker = Join-Path $StateDir "owns-dev-secrets"
if (!(Test-Path -LiteralPath $ownershipMarker -PathType Leaf) -or
    [IO.File]::ReadAllText($ownershipMarker).Trim() -ne "owned by dev/nuri-endpoint/control.sh") {
    throw "Refusing migration without controller-owned secret state"
}

$secretsItem = Get-Item -LiteralPath $secretsFile -Force -ErrorAction Stop
if ($secretsItem.LinkType -or $secretsItem.PSIsContainer) {
    throw "Controller secret state must be a regular non-symlink file"
}

$secrets = [IO.File]::ReadAllText($secretsFile) | ConvertFrom-Json
$connectionString = $secrets.globalSettings.sqlServer.connectionString
if ([string]::IsNullOrWhiteSpace($connectionString)) {
    throw "MSSQL connection string is missing from controller-owned secret state"
}

dotnet run --no-build --no-restore --project "$RepoRoot/util/MsSqlMigratorUtility" -- $connectionString
exit $LASTEXITCODE
