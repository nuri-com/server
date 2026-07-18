#!/usr/bin/env bash
set -euo pipefail

readonly ENVIRONMENT_FILE="${1:?missing environment file}"
readonly PROJECT="${2:?missing project path}"

[[ -f "${ENVIRONMENT_FILE}" ]] || {
  echo "missing isolated service environment: ${ENVIRONMENT_FILE}" >&2
  exit 1
}
[[ -f "${PROJECT}" ]] || {
  echo "missing service project: ${PROJECT}" >&2
  exit 1
}

while IFS= read -r -d '' entry; do
  name="${entry%%=*}"
  [[ "${name}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
    echo "invalid environment key in ${ENVIRONMENT_FILE}" >&2
    exit 1
  }
  export "${entry}"
done <"${ENVIRONMENT_FILE}"

exec dotnet run --no-launch-profile --no-build --no-restore --project "${PROJECT}"
