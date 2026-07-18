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
$privateFiles = Join-Path $PSScriptRoot "private-files.mjs"
$connectionStringEnvironmentVariable = "BITWARDEN_MSSQL_MIGRATOR_CONNECTION_STRING"

function Read-PrivateFile([string] $Path, [string] $Label) {
    $lines = @(& node $privateFiles read $Path $Label)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read $Label through the controller private-file boundary"
    }
    return [string]::Join([Environment]::NewLine, $lines)
}

& node $privateFiles secure-directory $StateDir "Controller state"
if ($LASTEXITCODE -ne 0) {
    throw "Controller state is not a private regular directory"
}

$markerText = Read-PrivateFile $ownershipMarker "dev/secrets.json ownership marker"
if ($markerText.Trim() -ne "owned by dev/nuri-endpoint/control.sh") {
    throw "Refusing migration without controller-owned secret state"
}

$secrets = Read-PrivateFile $secretsFile "dev/secrets.json" | ConvertFrom-Json
$connectionString = $secrets.globalSettings.sqlServer.connectionString
if ([string]::IsNullOrWhiteSpace($connectionString)) {
    throw "MSSQL connection string is missing from controller-owned secret state"
}

$previousConnectionString = [Environment]::GetEnvironmentVariable(
    $connectionStringEnvironmentVariable,
    [EnvironmentVariableTarget]::Process)
try {
    [Environment]::SetEnvironmentVariable(
        $connectionStringEnvironmentVariable,
        $connectionString,
        [EnvironmentVariableTarget]::Process)
    & dotnet run --no-build --no-restore --project "$RepoRoot/util/MsSqlMigratorUtility"
    $migratorExitCode = $LASTEXITCODE
}
finally {
    [Environment]::SetEnvironmentVariable(
        $connectionStringEnvironmentVariable,
        $previousConnectionString,
        [EnvironmentVariableTarget]::Process)
}
exit $migratorExitCode
