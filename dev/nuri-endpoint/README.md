# Nuri physical-device endpoint

This is the minimum local-only path for the Apple-to-Bitwarden-to-Android proof.
It starts only MSSQL, MailCatcher, Api, Identity, a loopback path gateway, and one
ngrok HTTPS endpoint. It does not deploy production infrastructure or add a
database schema.

The gateway exposes only these routes:

- `/api/*` -> local Api with `/api` stripped
- `/identity/*` -> local Identity with `/identity` preserved
- `/healthz` -> gateway health

MSSQL, SMTP, MailCatcher, Api, Identity, and the gateway all bind to loopback.
Only the gateway is reachable through ngrok. Request bodies and authentication
headers are never logged by the gateway.

## Exact pinned input

`c3f9ac90705a47b4566ed5b602ee919f70297b8e`

The controller refuses to run unless this commit is an ancestor of `HEAD`.
It also refuses tracked source changes and records the exact Git commit plus
content hashes of the Api, Identity, and migrator binaries after each successful
build. Existing binaries are reused only when that provenance still matches.

## Run

Use an external ignored state directory so credentials and build caches never
enter Git:

```sh
export NURI_ENDPOINT_STATE_DIR=/Users/eminmahrt/Developer/nuri-bitwarden/local/76-reachable-endpoint
dev/nuri-endpoint/control.sh start
```

`start` is non-interactive. It prepares ignored `dev/.env` and
`dev/secrets.json`, restores and sequentially builds Api, Identity, and the
MSSQL migrator, starts loopback-only dependencies, migrates the fresh database,
pins one ngrok URL, applies public service URIs, starts Api and Identity without
a concurrent build, and runs public health checks. It then stays in the
foreground so process lifetime is explicit; keep that terminal open and use
Ctrl-C for a clean stop.

Api and Identity run with the non-Development `SelfHosted` environment and
explicit loopback URLs. The controller creates an isolated password-protected
Identity certificate and injects configuration through mode-`0600` external
environment files, so the public test endpoint does not expose Developer
Exception Page output or development stack traces.

The controller never adopts pre-existing `dev/.env` or `dev/secrets.json`
files: a state-directory ownership marker must match files it created. Its
Compose project name is also fixed, so `stop` cannot target an unrelated local
Compose project. The Identity signing certificate is generated in the external
state directory as well, rather than adopting an ignored repository key. Before
ngrok starts, the controller rejects occupied service ports, validates stale PID
files against expected commands, and requires the gateway's exact local health
marker. It also forces the gateway host and port to `127.0.0.1:8088`.

MSSQL is considered ready only after an authenticated in-container `SELECT 1`.
The migration wrapper propagates the migrator's native exit code, so a failed
pre-login handshake or migration cannot be reported as successful preparation.
Package locks include the current `Data` project edge and restores run in locked
mode, preventing endpoint startup from silently rewriting dependency state.

The gateway contract can be checked without Docker or .NET:

```sh
node --test dev/nuri-endpoint/gateway.test.mjs
```

The first run deliberately uses a non-secret local placeholder for the hosting
installation values. This is sufficient for build, migration, process, gateway,
and discovery verification, but account registration remains gated.

## One secure insertion step

Request a free hosting installation ID/key from <https://bitwarden.com/host/>.
Then copy `installation.env.example` to
`$NURI_ENDPOINT_STATE_DIR/installation.env`, populate both values locally, and
run:

```sh
dev/nuri-endpoint/control.sh configure
```

The populated file is outside Git. The controller validates it, writes only to
ignored files and the isolated .NET user-secret store, and never prints either
value. Stop a running endpoint before configuring it, then run `start` again;
`configure` never leaves detached services behind.

The controller refuses preparation below 5 GiB of free disk. A clean first
build or missing container images require at least 6 GiB. This guard protects
the host from Docker or .NET filling the remaining disk during startup.

## Operate

```sh
dev/nuri-endpoint/control.sh status
dev/nuri-endpoint/control.sh health
dev/nuri-endpoint/control.sh stop
```

`stop` terminates only PIDs created by this controller and stops its Compose
project. It preserves the local database volume, ignored secrets, and caches.

IdentityServer intentionally uses the public HTTPS origin as `issuer`, while
its authorization, token, and JWKS endpoints include the public `/identity`
path exactly once. The health check asserts the exact endpoint values and
rejects any discovery document that leaks `localhost` or `127.0.0.1`. The
Identity process receives a root-only local override because its self-hosted
middleware contributes `/identity`; Api and client configuration still use the
public `/identity` service URL.
