import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const renderer = fileURLToPath(new URL("./render-secrets.mjs", import.meta.url));
const fixtures = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuri-endpoint-render-"));
  fixtures.push(root);
  const repo = path.join(root, "repo");
  const state = path.join(root, "state");
  fs.mkdirSync(path.join(repo, "dev"), { recursive: true });
  fs.mkdirSync(state, { mode: 0o755 });
  fs.writeFileSync(
    path.join(repo, "dev", ".env"),
    "MSSQL_PASSWORD=Fixture_Aa1!database\n" +
      "IDENTITY_CERTIFICATE_PASSWORD=Fixture_Aa1!certificate\n",
    { mode: 0o600 },
  );
  return { repo, state };
}

function runRenderer({ repo, state }) {
  return spawnSync(process.execPath, [renderer, repo, state], {
    encoding: "utf8",
  });
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function environment(file) {
  return new Map(
    fs
      .readFileSync(file, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writes only private controller-owned runtime files", () => {
  const current = fixture();
  const result = runRenderer(current);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(mode(current.state), 0o700);
  assert.equal(mode(path.join(current.state, "api.environment")), 0o600);
  assert.equal(mode(path.join(current.state, "identity.environment")), 0o600);
  assert.equal(mode(path.join(current.repo, "dev", "secrets.json")), 0o600);
  const api = environment(path.join(current.state, "api.environment"));
  const identity = environment(path.join(current.state, "identity.environment"));
  assert.equal(api.get("ASPNETCORE_ENVIRONMENT"), "SelfHosted");
  assert.equal(
    api.get("globalSettings__baseServiceUri__internalIdentity"),
    "http://127.0.0.1:33656/identity",
  );
  assert.equal(
    identity.get("globalSettings__baseServiceUri__identity"),
    "http://127.0.0.1:8088",
  );
  assert.equal(
    identity.get("globalSettings__baseServiceUri__internalIdentity"),
    "http://127.0.0.1:8088",
  );
  assert.equal(JSON.parse(result.stdout).installationConfigured, false);
});

test("secures installation.env before consuming it", () => {
  const current = fixture();
  const installation = path.join(current.state, "installation.env");
  fs.writeFileSync(
    installation,
    "BITWARDEN_INSTALLATION_ID=00000000-0000-4000-8000-000000000076\n" +
      "BITWARDEN_INSTALLATION_KEY=FixtureInstallationKey\n",
    { mode: 0o644 },
  );
  fs.chmodSync(installation, 0o644);

  const result = runRenderer(current);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(mode(installation), 0o600);
  assert.equal(JSON.parse(result.stdout).installationConfigured, true);
  assert.equal(result.stdout.includes("FixtureInstallationKey"), false);
});

test("rejects an installation.env symlink without revealing its contents", () => {
  const current = fixture();
  const privateValue = "FixtureInstallationValueMustStayPrivate";
  const target = path.join(path.dirname(current.state), "outside-installation.env");
  fs.writeFileSync(target, privateValue, { mode: 0o600 });
  fs.symlinkSync(target, path.join(current.state, "installation.env"));

  const result = runRenderer(current);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular non-symlink file/u);
  assert.equal(result.stderr.includes(privateValue), false);
});
