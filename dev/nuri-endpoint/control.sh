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
readonly DOCKER_ENV="${REPO_ROOT}/dev/.env"
readonly DOCKER_ENV_MARKER="${STATE_DIR}/owns-dev-env"

export DOTNET_CLI_HOME="${DOTNET_HOME}"
export NUGET_PACKAGES="${NUGET_PACKAGES_DIR}"
export DOTNET_NOLOGO=1
export DOTNET_CLI_TELEMETRY_OPTOUT=1

umask 077
mkdir -p "${STATE_DIR}" "${DOTNET_HOME}" "${NUGET_PACKAGES_DIR}" "${LOG_DIR}" "${PID_DIR}"

compose() {
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

write_docker_env() {
  if [[ -f "${DOCKER_ENV}" ]]; then
    [[ -f "${DOCKER_ENV_MARKER}" ]] || {
      echo "refusing to use existing unowned ${DOCKER_ENV}" >&2
      exit 1
    }
    grep -qx 'COMPOSE_PROJECT_NAME=bitwardenserver_nuri76' "${DOCKER_ENV}" || {
      echo "owned ${DOCKER_ENV} has an unexpected Compose project" >&2
      exit 1
    }
    return
  fi

  local password
  password="Nuri76_Aa1!$(openssl rand -hex 16)"
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
  } >"${DOCKER_ENV}"
  chmod 600 "${DOCKER_ENV}"
  printf 'owned by dev/nuri-endpoint/control.sh\n' >"${DOCKER_ENV_MARKER}"
  chmod 600 "${DOCKER_ENV_MARKER}"
  echo "created ignored dev/.env"
}

render_and_apply_secrets() {
  node "${SCRIPT_DIR}/render-secrets.mjs" "${REPO_ROOT}" "${STATE_DIR}"

  dotnet user-secrets set --project "${REPO_ROOT}/src/Api" \
    <"${REPO_ROOT}/dev/secrets.json" >/dev/null
  dotnet user-secrets set --project "${REPO_ROOT}/src/Identity" \
    <"${REPO_ROOT}/dev/secrets.json" >/dev/null

  local public_base
  public_base="$(node -e 'const fs=require("fs"); const p=process.argv[1]; console.log(fs.existsSync(p) ? fs.readFileSync(p,"utf8").trim() : "http://127.0.0.1:8088")' "${STATE_DIR}/public-base-url")"
  dotnet user-secrets set \
    "globalSettings:baseServiceUri:internalIdentity" \
    "http://127.0.0.1:33656/identity" \
    --project "${REPO_ROOT}/src/Api" >/dev/null
  # Identity's self-hosted PathBase already contributes /identity. Giving its
  # discovery rewriter the public root prevents a duplicated /identity path;
  # Api and clients still receive the public /identity service URL above.
  dotnet user-secrets set \
    "globalSettings:baseServiceUri:identity" \
    "${public_base}" \
    --project "${REPO_ROOT}/src/Identity" >/dev/null
  dotnet user-secrets set \
    "globalSettings:baseServiceUri:internalIdentity" \
    "${public_base}" \
    --project "${REPO_ROOT}/src/Identity" >/dev/null
  echo "applied secret-safe Api and Identity user-secret state"
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
  pwsh "${SCRIPT_DIR}/migrate.ps1" "${REPO_ROOT}"
}

pid_is_running() {
  local name="$1"
  local pid_file="${PID_DIR}/${name}.pid"
  [[ -f "${pid_file}" ]] && kill -0 "$(<"${pid_file}")" >/dev/null 2>&1
}

start_background() {
  local name="$1"
  shift
  if pid_is_running "${name}"; then
    echo "${name} already running"
    return
  fi
  nohup "$@" >"${LOG_DIR}/${name}.log" 2>&1 &
  echo "$!" >"${PID_DIR}/${name}.pid"
  echo "started ${name}"
}

start_gateway() {
  start_background gateway node "${SCRIPT_DIR}/gateway.mjs"
  wait_for_tcp 8088 "path gateway"
}

start_ngrok() {
  start_background ngrok ngrok http 127.0.0.1:8088 \
    --name nuri-bitwarden-76 \
    --description "Nuri Bitwarden physical-device proof" \
    --log "${LOG_DIR}/ngrok-agent.log" \
    --log-format json

  local attempt public_base
  for attempt in {1..60}; do
    public_base="$(curl -fsS http://127.0.0.1:4040/api/tunnels 2>/dev/null | node -e '
      let input="";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        try {
          const tunnel = JSON.parse(input).tunnels.find(
            item => item.proto === "https" && item.name === "nuri-bitwarden-76",
          );
          if (tunnel) process.stdout.write(tunnel.public_url);
        } catch {}
      });
    ' || true)"
    if [[ "${public_base}" == https://* ]]; then
      printf '%s\n' "${public_base%/}" >"${STATE_DIR}/public-base-url"
      chmod 600 "${STATE_DIR}/public-base-url"
      echo "pinned public base: ${public_base%/}"
      return
    fi
    sleep 1
  done
  echo "timed out waiting for ngrok HTTPS endpoint" >&2
  exit 1
}

start_services() {
  start_background identity env \
    DOTNET_CLI_HOME="${DOTNET_HOME}" \
    NUGET_PACKAGES="${NUGET_PACKAGES_DIR}" \
    DOTNET_NOLOGO=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    dotnet run --no-build --no-restore --project "${REPO_ROOT}/src/Identity/Identity.csproj"
  start_background api env \
    DOTNET_CLI_HOME="${DOTNET_HOME}" \
    NUGET_PACKAGES="${NUGET_PACKAGES_DIR}" \
    DOTNET_NOLOGO=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    dotnet run --no-build --no-restore --project "${REPO_ROOT}/src/Api/Api.csproj"
  wait_for_tcp 33656 "Identity"
  wait_for_tcp 4000 "Api"
}

health() {
  local public_base
  public_base="$(<"${STATE_DIR}/public-base-url")"
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
  local expected="$2"
  local pid_file="${PID_DIR}/${name}.pid"
  [[ -f "${pid_file}" ]] || return
  local pid command_line
  pid="$(<"${pid_file}")"
  command_line="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  if [[ -n "${command_line}" && "${command_line}" == *"${expected}"* ]]; then
    kill "${pid}"
    echo "stopped ${name}"
  fi
  rm -f "${pid_file}"
}

stop_services() {
  stop_one api "src/Api/Api.csproj"
  stop_one identity "src/Identity/Identity.csproj"
}

prepare() {
  verify_base
  for command in docker dotnet pwsh node ngrok curl nc openssl; do
    require_command "${command}"
  done
  disk_guard 5
  write_docker_env
  render_and_apply_secrets
  if [[ ! -f "${REPO_ROOT}/src/Identity/bin/Debug/net10.0/Identity.dll" ||
        ! -f "${REPO_ROOT}/src/Api/bin/Debug/net10.0/Api.dll" ||
        ! -f "${REPO_ROOT}/util/MsSqlMigratorUtility/bin/Debug/net10.0/MsSqlMigratorUtility.dll" ]]; then
    disk_guard 6
    restore_projects
    build_projects
  else
    echo "using existing exact-SHA Api and Identity builds"
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
  render_and_apply_secrets
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
  render_and_apply_secrets
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
  if [[ -f "${STATE_DIR}/public-base-url" ]]; then
    echo "public base: $(<"${STATE_DIR}/public-base-url")"
  fi
  if [[ -f "${STATE_DIR}/installation.env" ]]; then
    echo "installation credentials: configured locally"
  else
    echo "installation credentials: pending local insertion"
  fi
}

stop_all() {
  stop_services
  stop_one ngrok "ngrok http 127.0.0.1:8088"
  stop_one gateway "gateway.mjs"
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
