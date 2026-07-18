import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const controller = fileURLToPath(new URL("./control.sh", import.meta.url));
const fixtures = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stop_one validates and signals the same single-read PID across a file swap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuri-endpoint-pid-race-"));
  fixtures.push(root);
  const state = path.join(root, "state");
  const replacement = path.join(root, "replacement.pid");
  const reads = path.join(root, "reads.log");
  const signals = path.join(root, "signals.log");
  fs.mkdirSync(path.join(state, "pids"), { recursive: true });
  fs.writeFileSync(path.join(state, "pids", "gateway.pid"), "111\n");
  fs.writeFileSync(replacement, "222\n");

  const script = String.raw`
    source "$1"
    replacement_pid="$2"
    reads_log="$3"
    signals_log="$4"
    read_private_file() {
      local captured
      captured="$(command cat "$1")"
      printf 'read\n' >>"${"${reads_log}"}"
      if [[ -e "${"${replacement_pid}"}" ]]; then
        command mv "${"${replacement_pid}"}" "$1"
      fi
      printf '%s\n' "${"${captured}"}"
    }
    kill() {
      if [[ "$1" == "-0" ]]; then
        return 0
      fi
      printf '%s\n' "$1" >>"${"${signals_log}"}"
    }
    ps() {
      printf 'node gateway.mjs\n'
    }
    stop_one gateway
  `;
  const result = spawnSync(
    "bash",
    ["-c", script, "controller-test", controller, replacement, reads, signals],
    {
      encoding: "utf8",
      env: { ...process.env, NURI_ENDPOINT_STATE_DIR: state },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(reads, "utf8"), "read\n");
  assert.equal(fs.readFileSync(signals, "utf8"), "111\n");
  assert.equal(fs.existsSync(path.join(state, "pids", "gateway.pid")), false);
});
