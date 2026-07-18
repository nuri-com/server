import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  PRIVATE_FILE_TOKEN,
  runWithPrivateDotEnvironment,
  runWithPrivateInput,
  runWithPrivateLog,
} from "./private-files.mjs";

const fixtures = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuri-endpoint-private-race-"));
  fixtures.push(root);
  return root;
}

function replaceOpenedPath(file, replacement) {
  const opened = `${file}.opened`;
  fs.renameSync(file, opened);
  fs.writeFileSync(file, replacement, { mode: 0o600 });
  return opened;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Compose receives the opened dev/.env after a deterministic path swap", async () => {
  const root = fixture();
  const dockerEnvironment = path.join(root, ".env");
  const output = path.join(root, "compose.json");
  fs.writeFileSync(
    dockerEnvironment,
    "COMPOSE_PROJECT_NAME=bitwardenserver_nuri76\nMSSQL_PASSWORD=OriginalComposeSecret\n",
    { mode: 0o600 },
  );

  const status = await runWithPrivateDotEnvironment(
    dockerEnvironment,
    "dev/.env",
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');fs.writeFileSync(process.argv[1],JSON.stringify({" +
        "password:process.env.MSSQL_PASSWORD,args:process.argv.slice(2)}));",
      output,
      "compose",
      "--env-file",
      "/dev/null",
    ],
    {
      afterOpen() {
        replaceOpenedPath(
          dockerEnvironment,
          "COMPOSE_PROJECT_NAME=attacker\nMSSQL_PASSWORD=ReplacementComposeSecret\n",
        );
      },
    },
  );

  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
    password: "OriginalComposeSecret",
    args: ["compose", "--env-file", "/dev/null"],
  });
});

test("OpenSSL-style certificate input stays bound to the opened descriptor", async () => {
  const root = fixture();
  const certificate = path.join(root, "identity-server.pfx");
  const output = path.join(root, "certificate.txt");
  fs.writeFileSync(certificate, "OriginalCertificate", { mode: 0o600 });

  const status = await runWithPrivateInput(
    certificate,
    "Identity certificate",
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');fs.writeFileSync(process.argv[2],fs.readFileSync(process.argv[1]));",
      PRIVATE_FILE_TOKEN,
      output,
    ],
    {
      afterOpen() {
        replaceOpenedPath(certificate, "ReplacementCertificate");
      },
    },
  );

  assert.equal(status, 0);
  assert.equal(fs.readFileSync(output, "utf8"), "OriginalCertificate");
});

for (const [name, outputText] of [
  ["service log", "service-output"],
  ["ngrok log", '{"ngrok":"agent-output"}'],
]) {
  test(`${name} writes stay on the opened inode after a deterministic path swap`, async () => {
    const root = fixture();
    const log = path.join(root, `${name.replace(" ", "-")}.log`);
    let opened;

    const status = await runWithPrivateLog(
      log,
      name,
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(outputText)})`],
      {
        afterOpen() {
          opened = replaceOpenedPath(log, "ReplacementLogMustRemainUntouched");
        },
      },
    );

    assert.equal(status, 0);
    assert.equal(fs.readFileSync(opened, "utf8"), outputText);
    assert.equal(fs.readFileSync(log, "utf8"), "ReplacementLogMustRemainUntouched");
    assert.equal(fs.statSync(opened).mode & 0o777, 0o600);
  });
}
