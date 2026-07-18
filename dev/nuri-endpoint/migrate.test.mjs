import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const migrator = fileURLToPath(new URL("./migrate.ps1", import.meta.url));
const fixtures = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuri-endpoint-migrate-"));
  fixtures.push(root);
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  const argvLog = path.join(root, "argv.log");
  const environmentLog = path.join(root, "environment.log");
  const privateValue = "FixtureMigrationPasswordMustStayOutOfArgv";
  const connectionString =
    `Server=127.0.0.1;Database=vault_dev;User Id=SA;Password=${privateValue};` +
    "Encrypt=True;TrustServerCertificate=True";
  fs.mkdirSync(path.join(repo, "dev"), { recursive: true });
  fs.mkdirSync(path.join(repo, "util", "MsSqlMigratorUtility"), { recursive: true });
  fs.mkdirSync(state, { mode: 0o755 });
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(repo, "dev", "secrets.json"),
    `${JSON.stringify({ globalSettings: { sqlServer: { connectionString } } })}\n`,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(state, "owns-dev-secrets"),
    "owned by dev/nuri-endpoint/control.sh\n",
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(bin, "dotnet"),
    "#!/bin/sh\n" +
      'printf "%s\\n" "$@" >"$NURI_ARGV_LOG"\n' +
      'printf "%s" "$BITWARDEN_MSSQL_MIGRATOR_CONNECTION_STRING" >"$NURI_ENVIRONMENT_LOG"\n',
    { mode: 0o755 },
  );
  fs.chmodSync(path.join(bin, "dotnet"), 0o755);
  return {
    root,
    repo,
    state,
    bin,
    argvLog,
    environmentLog,
    privateValue,
    connectionString,
  };
}

function runMigrator(current) {
  return spawnSync("pwsh", [migrator, current.repo, current.state], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${current.bin}${path.delimiter}${process.env.PATH}`,
      NURI_ARGV_LOG: current.argvLog,
      NURI_ENVIRONMENT_LOG: current.environmentLog,
    },
  });
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("passes the MSSQL connection string only through the child environment", () => {
  const current = fixture();
  const result = runMigrator(current);
  assert.equal(result.status, 0, result.stderr);

  const argv = fs.readFileSync(current.argvLog, "utf8");
  assert.match(argv, /run\n/u);
  assert.match(argv, /MsSqlMigratorUtility/u);
  assert.equal(argv.includes(current.privateValue), false);
  assert.equal(argv.includes(current.connectionString), false);
  assert.equal(fs.readFileSync(current.environmentLog, "utf8"), current.connectionString);
  assert.equal(mode(path.join(current.repo, "dev", "secrets.json")), 0o600);
  assert.equal(mode(path.join(current.state, "owns-dev-secrets")), 0o600);
  assert.equal(mode(current.state), 0o700);
});

test("rejects a symlinked migration secret before invoking dotnet", () => {
  const current = fixture();
  const secretsFile = path.join(current.repo, "dev", "secrets.json");
  const target = path.join(current.root, "outside-secrets.json");
  fs.renameSync(secretsFile, target);
  fs.symlinkSync(target, secretsFile);

  const result = runMigrator(current);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /private-file boundary|non-symlink/u);
  assert.equal(fs.existsSync(current.argvLog), false);
  assert.equal(fs.readFileSync(target, "utf8").includes(current.privateValue), true);
  assert.equal(result.stdout.includes(current.privateValue), false);
  assert.equal(result.stderr.includes(current.privateValue), false);
});
