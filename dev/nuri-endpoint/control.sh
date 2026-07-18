#!/usr/bin/env bash
set -euo pipefail

readonly PINNED_SERVER_SHA="c3f9ac90705a47b4566ed5b602ee919f70297b8e"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly STATE_DIR="${NURI_ENDPOINT_STATE_DIR:-${REPO_ROOT}/dev/.nuri-endpoint}"
readonly DOTNET_HOME="${STATE_DIR}/dotnet-home"
readonly NUGET_PACKAGES_DIR="${STATE_DIR}/nuget-packages"
readonly LOG_DIR="${STATE_DIR}/logs"
readonly PID_DIR="${STATE_DIR}/pids"
readonly COMPOSE_OVERRIDE="${SCRIPT_DIR}/docker-compose.override.yml"
readonly COMPOSE_FILE="${REPO_ROOT}/dev/docker-compose.yml"
readonly PRIVATE_FILES="${SCRIPT_DIR}/private-files.mjs"
readonly DOCKER_ENV="${REPO_ROOT}/dev/.env"
readonly DOCKER_ENV_MARKER="${STATE_DIR}/owns-dev-env"
readonly BUILD_PROVENANCE="${STATE_DIR}/build-provenance"
readonly IDENTITY_CERTIFICATE="${STATE_DIR}/identity-server.pfx"
readonly API_DLL="${REPO_ROOT}/src/Api/bin/Debug/net10.0/Api.dll"
readonly IDENTITY_DLL="${REPO_ROOT}/src/Identity/bin/Debug/net10.0/Identity.dll"
readonly MIGRATOR_DLL="${REPO_ROOT}/util/MsSqlMigratorUtility/bin/Debug/net10.0/MsSqlMigratorUtility.dll"

export DOTNET_CLI_HOME="${DOTNET_HOME}"
export NUGET_PACKAGES="${NUGET_PACKAGES_DIR}"
export DOTNET_NOLOGO=1
export DOTNET_CLI_TELEMETRY_OPTOUT=1

umask 077
if [[ -L "${STATE_DIR}" || ( -e "${STATE_DIR}" && ! -d "${STATE_DIR}" ) ]]; then
  echo "controller state must be a regular non-symlink directory: ${STATE_DIR}" >&2
  exit 1
fi
mkdir -p "${STATE_DIR}"
node "${PRIVATE_FILES}" secure-directory "${STATE_DIR}" "Controller state"
for private_directory in "${DOTNET_HOME}" "${NUGET_PACKAGES_DIR}" "${LOG_DIR}" "${PID_DIR}"; do
  if [[ -L "${private_directory}" || ( -e "${private_directory}" && ! -d "${private_directory}" ) ]]; then
    echo "controller runtime directory must be a regular non-symlink directory: ${private_directory}" >&2
    exit 1
  fi
  mkdir -p "${private_directory}"
  node "${PRIVATE_FILES}" secure-directory "${private_directory}" "controller runtime directory"
done

path_exists_including_symlink() {
  [[ -e "$1" || -L "$1" ]]
}

secure_private_file() {
  node "${PRIVATE_FILES}" secure-file "$1" "$2"
}

read_private_file() {
  node "${PRIVATE_FILES}" read "$1" "$2"
}

atomic_write_private_file() {
  node "${PRIVATE_FILES}" write "$1" "$2"
}

verify_ownership_marker() {
  local marker="$1"
  local label="$2"
  [[ "$(read_private_file "${marker}" "${label}")" == "owned by dev/nuri-endpoint/control.sh" ]] || {
    echo "invalid ${label}" >&2
    return 1
  }
}

compose() {
  verify_ownership_marker "${DOCKER_ENV_MARKER}" "dev/.env ownership marker"
  secure_private_file "${DOCKER_ENV}" "dev/.env"
  docker compose \
    --project-name bitwardenserver_nuri76 \
    --env-file "${DOCKER_ENV}" \
    -f "${COMPOSE_FILE}" \
    -f "${COMPOSE_OVERRIDE}" \
    "$@"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

disk_guard() {
  local minimum_gib="${1:-2}"
  local available_kib
  available_kib="$(df -Pk "${STATE_DIR}" | awk 'NR == 2 { print $4 }')"
  if (( available_kib < minimum_gib * 1024 * 1024 )); then
    echo "refusing work: less than ${minimum_gib} GiB is free" >&2
    exit 1
  fi
}

verify_base() {
  git -C "${REPO_ROOT}" merge-base --is-ancestor "${PINNED_SERVER_SHA}" HEAD || {
    echo "HEAD does not contain pinned server SHA ${PINNED_SERVER_SHA}" >&2
    exit 1
  }
}

verify_tracked_source_clean() {
  if ! git -C "${REPO_ROOT}" diff --quiet -- ||
    ! git -C "${REPO_ROOT}" diff --cached --quiet --; then
    echo "refusing endpoint build: tracked source differs from HEAD" >&2
    exit 1
  fi
}

current_build_provenance() {
  local output
  git -C "${REPO_ROOT}" rev-parse HEAD
  for output in "${API_DLL}" "${IDENTITY_DLL}" "${MIGRATOR_DLL}"; do
    [[ -f "${output}" ]] || return 1
    git hash-object "${output}"
  done
}

build_outputs_are_current() {
  path_exists_including_symlink "${BUILD_PROVENANCE}" || return 1
  local recorded current
  recorded="$(read_private_file "${BUILD_PROVENANCE}" "build provenance")" || return 1
  current="$(current_build_provenance)" || return 1
  [[ "${recorded}" == "${current}" ]]
}

record_build_provenance() {
  verify_tracked_source_clean
  current_build_provenance | atomic_write_private_file "${BUILD_PROVENANCE}" "build provenance"
}

write_docker_env() {
  if path_exists_including_symlink "${DOCKER_ENV}"; then
    path_exists_including_symlink "${DOCKER_ENV_MARKER}" || {
      echo "refusing to use existing unowned ${DOCKER_ENV}" >&2
      exit 1
    }
    verify_ownership_marker "${DOCKER_ENV_MARKER}" "dev/.env ownership marker"
    local docker_environment
    docker_environment="$(read_private_file "${DOCKER_ENV}" "dev/.env")"
    grep -qx 'COMPOSE_PROJECT_NAME=bitwardenserver_nuri76' <<<"${docker_environment}" || {
      echo "owned ${DOCKER_ENV} has an unexpected Compose project" >&2
      exit 1
    }
    if ! grep -q '^IDENTITY_CERTIFICATE_PASSWORD=' <<<"${docker_environment}"; then
      {
        printf '%s\n' "${docker_environment}"
        printf 'IDENTITY_CERTIFICATE_PASSWORD=Nuri76_Cert_Aa1!%s\n' \
          "$(openssl rand -hex 16)"
      } | atomic_write_private_file "${DOCKER_ENV}" "dev/.env"
    fi
    return
  fi
  if path_exists_including_symlink "${DOCKER_ENV_MARKER}"; then
    verify_ownership_marker "${DOCKER_ENV_MARKER}" "dev/.env ownership marker"
  fi

  local password certificate_password
  password="Nuri76_Aa1!$(openssl rand -hex 16)"
  certificate_password="Nuri76_Cert_Aa1!$(openssl rand -hex 16)"
  {
    printf 'COMPOSE_PROJECT_NAME=bitwardenserver_nuri76\n'
    printf 'MSSQL_PASSWORD=%s\n' "${password}"
    printf 'MSSQL_SA_PASSWORD=%s\n' "${password}"
    printf 'MAILCATCHER_PORT=1080\n'
    printf 'POSTGRES_PASSWORD=%s\n' "${password}"
    printf 'MYSQL_ROOT_PASSWORD=%s\n' "${password}"
    printf 'MARIADB_ROOT_PASSWORD=%s\n' "${password}"
    printf 'IDP_SP_ENTITY_ID=http://127.0.0.1/unused\n'
    printf 'IDP_SP_ACS_URL=http://127.0.0.1/unused\n'
    printf 'API_PROXY_PORT=4100\n'
    printf 'IDENTITY_PROXY_PORT=33756\n'
    printf 'RABBITMQ_DEFAULT_USER=bitwarden\n'
    printf 'RABBITMQ_DEFAULT_PASS=%s\n' "${password}"
    printf 'IDENTITY_CERTIFICATE_PASSWORD=%s\n' "${certificate_password}"
  } | atomic_write_private_file "${DOCKER_ENV}" "dev/.env"
  printf 'owned by dev/nuri-endpoint/control.sh\n' |
    atomic_write_private_file "${DOCKER_ENV_MARKER}" "dev/.env ownership marker"
  echo "created ignored dev/.env"
}

ensure_identity_certificate() {
  local certificate_password
  certificate_password="$(
    node "${PRIVATE_FILES}" read-env "${DOCKER_ENV}" \
      IDENTITY_CERTIFICATE_PASSWORD "dev/.env"
  )"

  if path_exists_including_symlink "${IDENTITY_CERTIFICATE}"; then
    secure_private_file "${IDENTITY_CERTIFICATE}" "Identity certificate"
    if NURI_IDENTITY_CERT_PASSWORD="${certificate_password}" \
      openssl pkcs12 -in "${IDENTITY_CERTIFICATE}" -passin env:NURI_IDENTITY_CERT_PASSWORD \
        -noout >/dev/null 2>&1; then
      return
    fi
    echo "existing controller identity certificate cannot be opened; move it aside before retrying" >&2
    exit 1
  fi

  local temporary_key temporary_certificate temporary_bundle
  temporary_key="$(mktemp "${STATE_DIR}/identity-server.key.tmp.XXXXXX")"
  temporary_certificate="$(mktemp "${STATE_DIR}/identity-server.crt.tmp.XXXXXX")"
  temporary_bundle="$(mktemp "${STATE_DIR}/identity-server.pfx.tmp.XXXXXX")"
  chmod 600 "${temporary_key}" "${temporary_certificate}" "${temporary_bundle}"
  if ! NURI_IDENTITY_CERT_PASSWORD="${certificate_password}" \
    openssl req -x509 -newkey rsa:2048 -sha256 \
      -keyout "${temporary_key}" -out "${temporary_certificate}" \
      -subj "/CN=Nuri Bitwarden Device Test" -days 3650 \
      -passout env:NURI_IDENTITY_CERT_PASSWORD >/dev/null 2>&1; then
    rm -f "${temporary_key}" "${temporary_certificate}" "${temporary_bundle}"
    echo "failed to generate the isolated Identity certificate" >&2
    exit 1
  fi
  if ! NURI_IDENTITY_CERT_PASSWORD="${certificate_password}" \
    openssl pkcs12 -export -out "${temporary_bundle}" \
      -inkey "${temporary_key}" -in "${temporary_certificate}" \
      -passin env:NURI_IDENTITY_CERT_PASSWORD \
      -passout env:NURI_IDENTITY_CERT_PASSWORD >/dev/null 2>&1; then
    rm -f "${temporary_key}" "${temporary_certificate}" "${temporary_bundle}"
    echo "failed to package the isolated Identity certificate" >&2
    exit 1
  fi
  chmod 600 "${temporary_bundle}"
  mv -f "${temporary_bundle}" "${IDENTITY_CERTIFICATE}"
  secure_private_file "${IDENTITY_CERTIFICATE}" "Identity certificate"
  rm -f "${temporary_key}" "${temporary_certificate}"
  echo "created isolated non-Development Identity certificate"
}

render_runtime_config() {
  node "${SCRIPT_DIR}/render-secrets.mjs" "${REPO_ROOT}" "${STATE_DIR}"
  echo "applied isolated Api, Identity, and migrator configuration"
}

restore_projects() {
  dotnet restore "${REPO_ROOT}/util/MsSqlMigratorUtility/MsSqlMigratorUtility.csproj" \
    --locked-mode --nologo
  dotnet restore "${REPO_ROOT}/src/Identity/Identity.csproj" --locked-mode --nologo
  dotnet restore "${REPO_ROOT}/src/Api/Api.csproj" --locked-mode --nologo
}

build_projects() {
  disk_guard 6
  dotnet build "${REPO_ROOT}/util/MsSqlMigratorUtility/MsSqlMigratorUtility.csproj" \
    --no-restore --nologo
  disk_guard 6
  dotnet build "${REPO_ROOT}/src/Identity/Identity.csproj" --no-restore --nologo
  disk_guard 6
  dotnet build "${REPO_ROOT}/src/Api/Api.csproj" --no-restore --nologo
}

wait_for_tcp() {
  local port="$1"
  local label="$2"
  local attempt
  for attempt in {1..120}; do
    if nc -z 127.0.0.1 "${port}" >/dev/null 2>&1; then
      echo "${label} is accepting local connections"
      return
    fi
    sleep 1
  done
  echo "timed out waiting for ${label}" >&2
  exit 1
}

wait_for_mssql() {
  local attempt
  for attempt in {1..120}; do
    if compose exec -T mssql sh -c \
      '/opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -Q "SELECT 1"' \
      >/dev/null 2>&1; then
      echo "MSSQL login and query check passed"
      return
    fi
    sleep 1
  done
  echo "timed out waiting for MSSQL login readiness" >&2
  exit 1
}

dependencies_up() {
  if ! docker image inspect mcr.microsoft.com/mssql/server:2025-latest \
      sj26/mailcatcher:latest >/dev/null 2>&1; then
    disk_guard 6
  fi
  compose --profile mssql --profile mail up -d mssql mail
  wait_for_tcp 1433 "MSSQL"
  wait_for_mssql
  wait_for_tcp 10250 "MailCatcher SMTP"
}

migrate_database() {
  pwsh "${SCRIPT_DIR}/migrate.ps1" "${REPO_ROOT}" "${STATE_DIR}"
}

expected_command_for() {
  local name="$1"
  case "${name}" in
    gateway) printf '%s\n' "gateway.mjs" ;;
    ngrok) printf '%s\n' "ngrok http 127.0.0.1:8088" ;;
    identity) printf '%s\n' "src/Identity/Identity.csproj" ;;
    api) printf '%s\n' "src/Api/Api.csproj" ;;
    *) return 1 ;;
  esac
}

pid_is_running() {
  local name="$1"
  local pid_file="${PID_DIR}/${name}.pid"
  path_exists_including_symlink "${pid_file}" || return 1
  local pid expected command_line
  pid="$(read_private_file "${pid_file}" "${name} pid file")" || return 1
  [[ "${pid}" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
  kill -0 "${pid}" >/dev/null 2>&1 || return 1
  expected="$(expected_command_for "${name}")" || return 1
  command_line="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  [[ -n "${command_line}" && "${command_line}" == *"${expected}"* ]]
}

clear_stale_pid_file() {
  local name="$1"
  local pid_file="${PID_DIR}/${name}.pid"
  if path_exists_including_symlink "${pid_file}" && ! pid_is_running "${name}"; then
    rm -f "${pid_file}"
    echo "cleared stale ${name} pid file"
  fi
}

start_background() {
  local name="$1"
  shift
  if pid_is_running "${name}"; then
    echo "refusing to adopt an already running ${name} process" >&2
    return 1
  fi
  clear_stale_pid_file "${name}"
  local log_file="${LOG_DIR}/${name}.log"
  : | atomic_write_private_file "${log_file}" "${name} log"
  nohup "$@" >"${log_file}" 2>&1 &
  local started_pid="$!"
  if ! printf '%s\n' "${started_pid}" |
    atomic_write_private_file "${PID_DIR}/${name}.pid" "${name} pid file"; then
    kill "${started_pid}" >/dev/null 2>&1 || true
    return 1
  fi
  echo "started ${name}"
}

require_port_free() {
  local port="$1"
  local label="$2"
  if nc -z 127.0.0.1 "${port}" >/dev/null 2>&1; then
    echo "refusing to expose ${label}: loopback port ${port} is already occupied" >&2
    exit 1
  fi
}

wait_for_owned_tcp() {
  local name="$1"
  local port="$2"
  local label="$3"
  local attempt
  for attempt in {1..120}; do
    if ! pid_is_running "${name}"; then
      echo "${label} process exited before owning loopback port ${port}; inspect ${LOG_DIR}/${name}.log" >&2
      exit 1
    fi
    if nc -z 127.0.0.1 "${port}" >/dev/null 2>&1; then
      echo "${label} is accepting local connections from the expected process"
      return
    fi
    sleep 1
  done
  echo "timed out waiting for ${label}" >&2
  exit 1
}

verify_local_gateway() {
  curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:8088/healthz |
    node -e '
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const actual = JSON.parse(input);
        const expected = { ok: true, service: "nuri-bitwarden-gateway" };
        if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(1);
      });
    '
  echo "exact local gateway health marker passed"
}

start_gateway() {
  require_port_free 8088 "path gateway"
  start_background gateway env \
    NURI_GATEWAY_HOST=127.0.0.1 \
    NURI_GATEWAY_PORT=8088 \
    node "${SCRIPT_DIR}/gateway.mjs"
  wait_for_owned_tcp gateway 8088 "path gateway"
  verify_local_gateway
}

start_ngrok() {
  require_port_free 4040 "ngrok inspection API"
  : | atomic_write_private_file "${LOG_DIR}/ngrok-agent.log" "ngrok agent log"
  start_background ngrok ngrok http 127.0.0.1:8088 \
    --name nuri-bitwarden-76 \
    --description "Nuri Bitwarden physical-device proof" \
    --log "${LOG_DIR}/ngrok-agent.log" \
    --log-format json

  local attempt public_base
  for attempt in {1..60}; do
    if ! pid_is_running ngrok; then
      echo "ngrok exited before publishing the endpoint; inspect ${LOG_DIR}/ngrok.log" >&2
      exit 1
    fi
    public_base="$(curl -fsS http://127.0.0.1:4040/api/tunnels 2>/dev/null | node -e '
      let input="";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        try {
          const tunnel = JSON.parse(input).tunnels.find(
            item => item.proto === "https" &&
              item.name === "nuri-bitwarden-76" &&
              item.config?.addr === "http://127.0.0.1:8088",
          );
          if (tunnel) process.stdout.write(tunnel.public_url);
        } catch {}
      });
    ' || true)"
    if [[ "${public_base}" == https://* ]]; then
      printf '%s\n' "${public_base%/}" |
        atomic_write_private_file "${STATE_DIR}/public-base-url" "public-base-url"
      echo "pinned public base: ${public_base%/}"
      return
    fi
    sleep 1
  done
  echo "timed out waiting for ngrok HTTPS endpoint" >&2
  exit 1
}

start_services() {
  require_port_free 33656 "Identity"
  require_port_free 4000 "Api"
  start_background identity "${SCRIPT_DIR}/run-service.sh" \
    "${STATE_DIR}/identity.environment" \
    "${REPO_ROOT}/src/Identity/Identity.csproj"
  wait_for_owned_tcp identity 33656 "Identity"
  require_port_free 4000 "Api"
  start_background api "${SCRIPT_DIR}/run-service.sh" \
    "${STATE_DIR}/api.environment" \
    "${REPO_ROOT}/src/Api/Api.csproj"
  wait_for_owned_tcp api 4000 "Api"
}

health() {
  local public_base
  public_base="$(read_private_file "${STATE_DIR}/public-base-url" "public-base-url")"
  curl -fsS "${public_base}/healthz" >/dev/null
  curl -fsS "${public_base}/api/alive" >/dev/null
  curl -fsS "${public_base}/identity/.well-known/openid-configuration" |
    node -e '
      let input="";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const discovery = JSON.parse(input);
        const publicBase = process.argv[1];
        const expectedIssuer = new URL(publicBase).origin;
        if (discovery.issuer !== expectedIssuer) {
          throw new Error(`unexpected issuer: ${discovery.issuer}`);
        }
        const expectedEndpoints = {
          authorization_endpoint: `${publicBase}/identity/connect/authorize`,
          token_endpoint: `${publicBase}/identity/connect/token`,
          jwks_uri: `${publicBase}/identity/.well-known/openid-configuration/jwks`,
        };
        for (const [key, expected] of Object.entries(expectedEndpoints)) {
          if (discovery[key] !== expected) {
            throw new Error(`${key} is not exact: ${discovery[key]} != ${expected}`);
          }
        }
        if (input.includes("127.0.0.1") || input.includes("localhost")) {
          throw new Error("discovery leaks a loopback endpoint");
        }
      });
    ' "${public_base}"
  echo "public gateway, Api alive, and Identity discovery checks passed"
}

stop_one() {
  local name="$1"
  local pid_file="${PID_DIR}/${name}.pid"
  path_exists_including_symlink "${pid_file}" || return 0
  local pid
  pid="$(read_private_file "${pid_file}" "${name} pid file")" || return
  if pid_is_running "${name}"; then
    kill "${pid}"
    echo "stopped ${name}"
  elif [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" >/dev/null 2>&1; then
    echo "refused to signal unexpected process from stale ${name} pid file" >&2
  fi
  rm -f "${pid_file}"
}

stop_services() {
  stop_one api
  stop_one identity
}

prepare() {
  for command in docker dotnet git ps pwsh node ngrok curl nc openssl mktemp; do
    require_command "${command}"
  done
  verify_base
  verify_tracked_source_clean
  disk_guard 5
  write_docker_env
  ensure_identity_certificate
  render_runtime_config
  if ! build_outputs_are_current; then
    rm -f "${BUILD_PROVENANCE}"
    disk_guard 6
    restore_projects
    build_projects
    record_build_provenance
  else
    echo "using commit-bound Api, Identity, and migrator builds"
  fi
  if ! dependencies_up; then
    compose --profile mssql --profile mail down || true
    return 1
  fi
  if ! migrate_database; then
    compose --profile mssql --profile mail down || true
    return 1
  fi
  echo "preparation complete"
}

start_all() {
  trap 'stop_all || true' EXIT
  trap 'exit 0' HUP INT TERM
  prepare
  start_gateway
  start_ngrok
  render_runtime_config
  start_services
  health
  if [[ ! -f "${STATE_DIR}/installation.env" ]]; then
    echo "installation credentials are not configured; health is ready, account registration is intentionally gated"
  fi
  echo "endpoint is running; keep this process open and press Ctrl-C to stop it cleanly"
  while pid_is_running gateway &&
    pid_is_running ngrok &&
    pid_is_running identity &&
    pid_is_running api; do
    sleep 5
  done
  echo "an endpoint process exited unexpectedly; inspect ${LOG_DIR}" >&2
  exit 1
}

configure_installation() {
  [[ -f "${STATE_DIR}/installation.env" ]] || {
    echo "missing ${STATE_DIR}/installation.env" >&2
    exit 1
  }
  if pid_is_running gateway || pid_is_running ngrok ||
    pid_is_running identity || pid_is_running api; then
    echo "stop the running endpoint before applying installation credentials" >&2
    exit 1
  fi
  render_runtime_config
  echo "installation credentials applied without printing them; run start to launch the endpoint"
}

status() {
  local name
  for name in gateway ngrok identity api; do
    if pid_is_running "${name}"; then
      echo "${name}: running"
    else
      echo "${name}: stopped"
    fi
  done
  if path_exists_including_symlink "${STATE_DIR}/public-base-url"; then
    echo "public base: $(read_private_file "${STATE_DIR}/public-base-url" "public-base-url")"
  fi
  if [[ -f "${STATE_DIR}/installation.env" ]]; then
    echo "installation credentials: configured locally"
  else
    echo "installation credentials: pending local insertion"
  fi
}

stop_all() {
  stop_services
  stop_one ngrok
  stop_one gateway
  if [[ -f "${DOCKER_ENV}" ]]; then
    compose --profile mssql --profile mail down
  fi
  echo "endpoint stopped; database volume and ignored secrets were preserved"
}

case "${1:-}" in
  prepare) prepare ;;
  start) start_all ;;
  configure) configure_installation ;;
  health) health ;;
  status) status ;;
  stop) stop_all ;;
  *)
    echo "usage: $0 {prepare|start|configure|health|status|stop}" >&2
    exit 64
    ;;
esac
