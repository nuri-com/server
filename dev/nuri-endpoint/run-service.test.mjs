import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runPrivateService } from "./private-files.mjs";

const launcher = fileURLToPath(new URL("./run-service.sh", import.meta.url));
const fixtures = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuri-endpoint-service-"));
  fixtures.push(root);
  const bin = path.join(root, "bin");
  const environmentFile = path.join(root, "api.environment");
  const certificateFile = path.join(root, "identity-server.pfx");
  const project = path.join(root, "Api.csproj");
  const invocationLog = path.join(root, "invocation.log");
  const privateValue = "FixtureRuntimeSecret";
  fs.mkdirSync(bin);
  fs.writeFileSync(environmentFile, `ASPNETCORE_ENVIRONMENT=SelfHosted\0PRIVATE_VALUE=${privateValue}\0`, {
    mode: 0o644,
  });
  fs.chmodSync(environmentFile, 0o644);
  fs.writeFileSync(certificateFile, "FixtureIdentityCertificate", { mode: 0o644 });
  fs.writeFileSync(project, "<Project />\n");
  fs.writeFileSync(
    path.join(bin, "dotnet"),
    "#!/bin/sh\n" +
      'printf "%s\\n" "$@" >"$NURI_INVOCATION_LOG"\n' +
      'certificate_path="$(printenv globalSettings__identityServer__certificateLocation)"\n' +
      'printf "environment=%s\\nprivate=%s\\ncertificate-path=%s\\n" "$ASPNETCORE_ENVIRONMENT" "$PRIVATE_VALUE" "$certificate_path" >>"$NURI_INVOCATION_LOG"\n' +
      'printf "certificate=" >>"$NURI_INVOCATION_LOG"\n' +
      'cat "$certificate_path" >>"$NURI_INVOCATION_LOG"\n',
    { mode: 0o755 },
  );
  fs.chmodSync(path.join(bin, "dotnet"), 0o755);
  return {
    root,
    bin,
    environmentFile,
    certificateFile,
    project,
    invocationLog,
    privateValue,
  };
}

function runLauncher(current) {
  return spawnSync(
    "bash",
    [launcher, current.environmentFile, current.certificateFile, current.project],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${current.bin}${path.delimiter}${process.env.PATH}`,
        NURI_INVOCATION_LOG: current.invocationLog,
      },
    },
  );
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
  assert.equal(fs.statSync(current.certificateFile).mode & 0o777, 0o600);
  const invocation = fs.readFileSync(current.invocationLog, "utf8");
  assert.match(invocation, /environment=SelfHosted/u);
  assert.match(invocation, new RegExp(`private=${current.privateValue}`, "u"));
  assert.match(invocation, /certificate-path=\/(?:dev\/fd|proc\/self\/fd)\/3/u);
  assert.match(invocation, /certificate=FixtureIdentityCertificate/u);
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

test("rejects a symlinked Identity certificate before invoking dotnet", () => {
  const current = fixture();
  const target = path.join(current.root, "outside-certificate.pfx");
  fs.renameSync(current.certificateFile, target);
  fs.symlinkSync(target, current.certificateFile);

  const result = runLauncher(current);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular non-symlink file/u);
  assert.equal(fs.existsSync(current.invocationLog), false);
});

test("keeps the opened service environment and certificate across path swaps", async () => {
  const current = fixture();
  const output = path.join(current.root, "race-output.json");
  const command = [
    "-e",
    "const fs=require('node:fs');" +
      "const certificatePath=process.env.globalSettings__identityServer__certificateLocation;" +
      "fs.writeFileSync(process.argv[1],JSON.stringify({" +
      "environment:process.env.ASPNETCORE_ENVIRONMENT," +
      "privateValue:process.env.PRIVATE_VALUE," +
      "certificatePath," +
      "certificate:fs.readFileSync(certificatePath,'utf8')}));",
    output,
  ];

  const status = await runPrivateService(
    current.environmentFile,
    current.certificateFile,
    process.execPath,
    command,
    {
      afterOpen() {
        fs.renameSync(current.environmentFile, `${current.environmentFile}.opened`);
        fs.writeFileSync(
          current.environmentFile,
          "ASPNETCORE_ENVIRONMENT=Replacement\0PRIVATE_VALUE=ReplacementSecret\0",
          { mode: 0o600 },
        );
        fs.renameSync(current.certificateFile, `${current.certificateFile}.opened`);
        fs.writeFileSync(current.certificateFile, "ReplacementCertificate", { mode: 0o600 });
      },
    },
  );

  assert.equal(status, 0);
  const actual = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.match(actual.certificatePath, /^\/(?:dev\/fd|proc\/self\/fd)\/3$/u);
  assert.deepEqual({ ...actual, certificatePath: "<inherited-fd>" }, {
    environment: "SelfHosted",
    privateValue: current.privateValue,
    certificatePath: "<inherited-fd>",
    certificate: "FixtureIdentityCertificate",
  });
});
