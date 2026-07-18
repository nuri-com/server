import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
export const PRIVATE_FILE_TOKEN = "{private-file}";

export function pathExistsIncludingSymlink(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertRegularDirectory(directory, label) {
  const current = fs.lstatSync(directory);
  if (current.isSymbolicLink() || !current.isDirectory()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
}

export function securePrivateDirectory(directory, label = "private directory") {
  const current = fs.lstatSync(directory);
  if (current.isSymbolicLink() || !current.isDirectory()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isDirectory() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`${label} must be a regular non-symlink directory`);
    }
    fs.fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
    if ((fs.fstatSync(descriptor).mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw new Error(`${label} permissions must be 0700`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function openPrivateFile(file, label, flags = fs.constants.O_RDONLY) {
  const current = fs.lstatSync(file);
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }

  const descriptor = fs.openSync(file, flags | NO_FOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    if ((fs.fstatSync(descriptor).mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error(`${label} permissions must be 0600`);
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function securePrivateFile(file, label = "private file") {
  const descriptor = openPrivateFile(file, label);
  fs.closeSync(descriptor);
}

export function readPrivateFile(file, label = "private file", encoding, options = {}) {
  const descriptor = openPrivateFile(file, label);
  try {
    options.afterOpen?.();
    return fs.readFileSync(descriptor, encoding);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function atomicWritePrivateFile(file, contents, label = "private file") {
  const directory = path.dirname(file);
  assertRegularDirectory(directory, `${label} parent directory`);
  if (pathExistsIncludingSymlink(file)) {
    securePrivateFile(file, label);
  }

  const temporary = path.join(
    directory,
    `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        NO_FOLLOW,
      PRIVATE_FILE_MODE,
    );
    fs.writeFileSync(descriptor, contents);
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    if ((fs.fstatSync(descriptor).mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error(`${label} temporary file permissions must be 0600`);
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    securePrivateFile(file, label);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export function readPrivateEnvironmentValue(file, key, label = "private environment") {
  const contents = readPrivateFile(file, label, "utf8");
  const match = contents
    .split(/\r?\n/u)
    .find((line) => line.startsWith(`${key}=`));
  if (!match) throw new Error(`${key} is missing from ${label}`);
  return match.slice(match.indexOf("=") + 1);
}

function descriptorPath(descriptor = 3) {
  const root = fs.existsSync("/dev/fd") ? "/dev/fd" : "/proc/self/fd";
  if (!fs.existsSync(root)) {
    throw new Error("This platform does not expose inherited file descriptors as paths");
  }
  return `${root}/${descriptor}`;
}

function commandArguments(values) {
  const separator = values.indexOf("--");
  if (separator < 0 || separator === values.length - 1) usage();
  return {
    before: values.slice(0, separator),
    command: values[separator + 1],
    arguments: values.slice(separator + 2),
  };
}

function replacePrivateFileToken(arguments_, replacement) {
  let replaced = false;
  const result = arguments_.map((argument) => {
    if (!argument.includes(PRIVATE_FILE_TOKEN)) return argument;
    replaced = true;
    return argument.replaceAll(PRIVATE_FILE_TOKEN, replacement);
  });
  if (!replaced) throw new Error(`Command must contain ${PRIVATE_FILE_TOKEN}`);
  return result;
}

function parseDotEnvironment(contents, label) {
  const environment = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const name = line.slice(0, separator).trim();
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid environment entry in ${label}`);
    }
    environment[name] = line.slice(separator + 1).trim();
  }
  return environment;
}

function parseNulEnvironment(contents, label) {
  const environment = {};
  for (const entry of contents.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator);
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid environment entry in ${label}`);
    }
    environment[name] = entry.slice(separator + 1);
  }
  return environment;
}

function spawnAndWait(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, options);
    const handlers = new Map();
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
      const handler = () => child.kill(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
      resolve(code ?? signalExitCodes[signal] ?? 1);
    });
  });
}

export async function runWithPrivateInput(
  file,
  label,
  command,
  arguments_,
  options = {},
) {
  const descriptor = openPrivateFile(file, label);
  try {
    options.afterOpen?.();
    const inheritedPath = descriptorPath();
    return await spawnAndWait(
      command,
      replacePrivateFileToken(arguments_, inheritedPath),
      {
        env: process.env,
        stdio: ["inherit", "inherit", "inherit", descriptor],
      },
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function runWithPrivateDotEnvironment(
  file,
  label,
  command,
  arguments_,
  options = {},
) {
  const descriptor = openPrivateFile(file, label);
  try {
    options.afterOpen?.();
    const privateEnvironment = parseDotEnvironment(
      fs.readFileSync(descriptor, "utf8"),
      label,
    );
    return await spawnAndWait(command, arguments_, {
      env: { ...process.env, ...privateEnvironment },
      stdio: "inherit",
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function runPrivateService(
  environmentFile,
  certificateFile,
  command,
  arguments_,
  options = {},
) {
  const environmentDescriptor = openPrivateFile(environmentFile, "service environment");
  const certificateDescriptor = openPrivateFile(certificateFile, "Identity certificate");
  try {
    options.afterOpen?.();
    const privateEnvironment = parseNulEnvironment(
      fs.readFileSync(environmentDescriptor, "utf8"),
      "service environment",
    );
    privateEnvironment.globalSettings__identityServer__certificateLocation = descriptorPath();
    return await spawnAndWait(command, arguments_, {
      env: { ...process.env, ...privateEnvironment },
      stdio: ["inherit", "inherit", "inherit", certificateDescriptor],
    });
  } finally {
    fs.closeSync(environmentDescriptor);
    fs.closeSync(certificateDescriptor);
  }
}

export async function runWithPrivateLog(file, label, command, arguments_, options = {}) {
  atomicWritePrivateFile(file, Buffer.alloc(0), label);
  const descriptor = openPrivateFile(file, label, fs.constants.O_WRONLY | fs.constants.O_APPEND);
  try {
    options.afterOpen?.();
    return await spawnAndWait(command, arguments_, {
      env: process.env,
      stdio: ["ignore", descriptor, descriptor],
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function usage() {
  throw new Error(
    "usage: private-files.mjs {secure-directory|secure-file|read|write|read-env|run-input|run-dotenv|run-service|run-logged} ...",
  );
}

async function main() {
  const [command, file, argument, extra, ...remaining] = process.argv.slice(2);
  if (!command || !file) usage();
  switch (command) {
    case "secure-directory":
      securePrivateDirectory(file, argument);
      break;
    case "secure-file":
      securePrivateFile(file, argument);
      break;
    case "read":
      process.stdout.write(readPrivateFile(file, argument));
      break;
    case "write":
      atomicWritePrivateFile(file, fs.readFileSync(0), argument);
      break;
    case "read-env":
      if (!argument) usage();
      process.stdout.write(readPrivateEnvironmentValue(file, argument, extra));
      break;
    case "run-input": {
      const child = commandArguments([extra, ...remaining]);
      if (!argument || child.before.length !== 0) usage();
      process.exitCode = await runWithPrivateInput(
        file,
        argument,
        child.command,
        child.arguments,
      );
      break;
    }
    case "run-dotenv": {
      const child = commandArguments([extra, ...remaining]);
      if (!argument || child.before.length !== 0) usage();
      process.exitCode = await runWithPrivateDotEnvironment(
        file,
        argument,
        child.command,
        child.arguments,
      );
      break;
    }
    case "run-service": {
      const child = commandArguments([extra, ...remaining]);
      if (!argument || child.before.length !== 0) usage();
      process.exitCode = await runPrivateService(file, argument, child.command, child.arguments);
      break;
    }
    case "run-logged": {
      const child = commandArguments([extra, ...remaining]);
      if (!argument || child.before.length !== 0) usage();
      process.exitCode = await runWithPrivateLog(
        file,
        argument,
        child.command,
        child.arguments,
      );
      break;
    }
    default:
      usage();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
