import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

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
  assertRegularDirectory(directory, label);
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isDirectory()) {
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

function openPrivateFile(file, label) {
  const current = fs.lstatSync(file);
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }

  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) {
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

export function readPrivateFile(file, label = "private file", encoding) {
  const descriptor = openPrivateFile(file, label);
  try {
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

function usage() {
  throw new Error(
    "usage: private-files.mjs {secure-directory|secure-file|read|write|read-env} PATH [LABEL|KEY] [LABEL]",
  );
}

function main() {
  const [command, file, argument, extra] = process.argv.slice(2);
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
    default:
      usage();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
