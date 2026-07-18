import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("./run-service.sh", import.meta.url));
const fixtures = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuri-endpoint-service-"));
  fixtures.push(root);
  const bin = path.join(root, "bin");
  const environmentFile = path.join(root, "api.environment");
  const project = path.join(root, "Api.csproj");
  const invocationLog = path.join(root, "invocation.log");
  const privateValue = "FixtureRuntimeSecret";
  fs.mkdirSync(bin);
  fs.writeFileSync(environmentFile, `ASPNETCORE_ENVIRONMENT=SelfHosted\0PRIVATE_VALUE=${privateValue}\0`, {
    mode: 0o644,
  });
  fs.chmodSync(environmentFile, 0o644);
  fs.writeFileSync(project, "<Project />\n");
  fs.writeFileSync(
    path.join(bin, "dotnet"),
    "#!/bin/sh\n" +
      'printf "%s\\n" "$@" >"$NURI_INVOCATION_LOG"\n' +
      'printf "environment=%s\\nprivate=%s\\n" "$ASPNETCORE_ENVIRONMENT" "$PRIVATE_VALUE" >>"$NURI_INVOCATION_LOG"\n',
    { mode: 0o755 },
  );
  fs.chmodSync(path.join(bin, "dotnet"), 0o755);
  return { root, bin, environmentFile, project, invocationLog, privateValue };
}

function runLauncher(current) {
  return spawnSync("bash", [launcher, current.environmentFile, current.project], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${current.bin}${path.delimiter}${process.env.PATH}`,
      NURI_INVOCATION_LOG: current.invocationLog,
    },
  });
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repairs the service environment mode before reading it", () => {
  const current = fixture();
  const result = runLauncher(current);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(current.environmentFile).mode & 0o777, 0o600);
  const invocation = fs.readFileSync(current.invocationLog, "utf8");
  assert.match(invocation, /environment=SelfHosted/u);
  assert.match(invocation, new RegExp(`private=${current.privateValue}`, "u"));
  assert.equal(invocation.split("environment=")[0].includes(current.privateValue), false);
});

test("rejects a symlinked service environment before invoking dotnet", () => {
  const current = fixture();
  const target = path.join(current.root, "outside.environment");
  fs.renameSync(current.environmentFile, target);
  fs.symlinkSync(target, current.environmentFile);

  const result = runLauncher(current);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular non-symlink file/u);
  assert.equal(fs.existsSync(current.invocationLog), false);
  assert.equal(result.stderr.includes(current.privateValue), false);
});
