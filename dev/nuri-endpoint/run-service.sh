#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PRIVATE_FILES="${SCRIPT_DIR}/private-files.mjs"
readonly ENVIRONMENT_FILE="${1:?missing environment file}"
readonly IDENTITY_CERTIFICATE="${2:?missing Identity certificate}"
readonly PROJECT="${3:?missing project path}"

[[ -f "${PROJECT}" ]] || {
  echo "missing service project: ${PROJECT}" >&2
  exit 1
}

exec node "${PRIVATE_FILES}" run-service \
  "${ENVIRONMENT_FILE}" "${IDENTITY_CERTIFICATE}" -- \
  dotnet run --no-launch-profile --no-build --no-restore --project "${PROJECT}"
