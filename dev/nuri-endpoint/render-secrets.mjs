import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.argv[2] ?? ".");
const stateDir = path.resolve(process.argv[3] ?? "");
const publicBaseFile = path.join(stateDir, "public-base-url");
const installationFile = path.join(stateDir, "installation.env");
const ownershipMarker = path.join(stateDir, "owns-dev-secrets");
const dockerEnvFile = path.join(repoRoot, "dev", ".env");
const outputFile = path.join(repoRoot, "dev", "secrets.json");
const apiEnvironmentFile = path.join(stateDir, "api.environment");
const identityEnvironmentFile = path.join(stateDir, "identity.environment");

function parseEnv(file) {
  const values = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Invalid environment entry in ${file}`);
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

const dockerEnv = parseEnv(dockerEnvFile);
if (!dockerEnv.MSSQL_PASSWORD) throw new Error("MSSQL_PASSWORD is missing");
if (!dockerEnv.IDENTITY_CERTIFICATE_PASSWORD) {
  throw new Error("IDENTITY_CERTIFICATE_PASSWORD is missing");
}

let publicBase = "http://127.0.0.1:8088";
if (fs.existsSync(publicBaseFile)) {
  publicBase = fs.readFileSync(publicBaseFile, "utf8").trim().replace(/\/$/u, "");
}
const parsedBase = new URL(publicBase);
if (parsedBase.protocol !== "https:" && parsedBase.hostname !== "127.0.0.1") {
  throw new Error("Public base must be HTTPS or the loopback preparation endpoint");
}

// A non-zero, visibly local UUID lets the self-hosted services boot for health
// verification. Account registration remains gated on the real hosting pair.
let installationId = "00000000-0000-4000-8000-000000000076";
let installationKey = "LOCAL_PREPARE_ONLY";
let installationConfigured = false;
if (fs.existsSync(installationFile)) {
  const installation = parseEnv(installationFile);
  installationId = installation.BITWARDEN_INSTALLATION_ID ?? "";
  installationKey = installation.BITWARDEN_INSTALLATION_KEY ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(installationId)) {
    throw new Error("BITWARDEN_INSTALLATION_ID must be a UUID");
  }
  if (installationKey.length < 16) {
    throw new Error("BITWARDEN_INSTALLATION_KEY is missing or too short");
  }
  installationConfigured = true;
}

const dataProtectionDirectory = path.join(stateDir, "data-protection");
const licenseDirectory = path.join(stateDir, "licenses");
fs.mkdirSync(dataProtectionDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(licenseDirectory, { recursive: true, mode: 0o700 });

const config = {
  globalSettings: {
    selfHosted: true,
    baseServiceUri: {
      vault: publicBase,
      api: `${publicBase}/api`,
      identity: `${publicBase}/identity`,
      notifications: `${publicBase}/notifications`,
      sso: `${publicBase}/sso`,
      internalApi: "http://127.0.0.1:4000",
      internalIdentity: "http://127.0.0.1:33656/identity",
      // The non-Development OIDC post-configure guard requires an HTTPS
      // authority even though SSO is intentionally outside this harness.
      internalSso: `${publicBase}/sso`,
    },
    sqlServer: {
      connectionString: `Server=127.0.0.1;Database=vault_dev;User Id=SA;Password=${dockerEnv.MSSQL_PASSWORD};Encrypt=True;TrustServerCertificate=True`,
    },
    identityServer: {
      certificateLocation: path.join(stateDir, "identity-server.pfx"),
      certificatePassword: dockerEnv.IDENTITY_CERTIFICATE_PASSWORD,
    },
    dataProtection: { directory: dataProtectionDirectory },
    installation: { id: installationId, key: installationKey },
    events: { connectionString: "", queueName: "event" },
    licenseDirectory,
    enableNewDeviceVerification: false,
    enableEmailVerification: false,
    developmentDirectory: stateDir,
    mail: { smtp: { host: "127.0.0.1", port: 10250 } },
    communication: {
      bootstrap: "none",
      ssoCookieVendor: { idpLoginUrl: "", cookieName: "", cookieDomain: "" },
    },
  },
};

function flattenEnvironment(value, prefix = "", result = []) {
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flattenEnvironment(child, prefix ? `${prefix}__${key}` : key, result);
    }
    return result;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(prefix.replaceAll("__", "_"))) {
    throw new Error(`Invalid environment key: ${prefix}`);
  }
  result.push([prefix, String(value ?? "")]);
  return result;
}

function writeServiceEnvironment(file, serviceConfig, port) {
  const entries = [
    ["ASPNETCORE_ENVIRONMENT", "SelfHosted"],
    ["DOTNET_ENVIRONMENT", "SelfHosted"],
    ["ASPNETCORE_URLS", `http://127.0.0.1:${port}`],
    ...flattenEnvironment(serviceConfig),
  ];
  const serialized = entries.map(([key, value]) => `${key}=${value}\0`).join("");
  fs.writeFileSync(file, serialized, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const identityConfig = JSON.parse(JSON.stringify(config));
identityConfig.globalSettings.baseServiceUri.identity = publicBase;
identityConfig.globalSettings.baseServiceUri.internalIdentity = publicBase;
writeServiceEnvironment(apiEnvironmentFile, config, 4000);
writeServiceEnvironment(identityEnvironmentFile, identityConfig, 33656);

if (fs.existsSync(outputFile) && !fs.existsSync(ownershipMarker)) {
  throw new Error(
    `Refusing to overwrite existing ${outputFile}; move it aside or explicitly mark it as controller-owned`,
  );
}
fs.writeFileSync(outputFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(outputFile, 0o600);
fs.writeFileSync(ownershipMarker, "owned by dev/nuri-endpoint/control.sh\n", {
  mode: 0o600,
});
fs.chmodSync(ownershipMarker, 0o600);
console.log(
  JSON.stringify({
    ok: true,
    publicBase,
    installationConfigured,
    output: "dev/secrets.json",
    runtimeEnvironment: "SelfHosted",
  }),
);
