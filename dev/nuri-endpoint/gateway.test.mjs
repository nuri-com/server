import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const gatewayPath = fileURLToPath(new URL("./gateway.mjs", import.meta.url));
const upstreams = [];
let gateway;

function listen(port) {
  const server = http.createServer((request, response) => {
    let bodyLength = 0;
    request.on("data", (chunk) => {
      bodyLength += chunk.length;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: request.method,
          path: request.url,
          forwardedHost: request.headers["x-forwarded-host"],
          bodyLength,
        }),
      );
    });
  });
  upstreams.push(server);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

async function waitForGateway() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch("http://127.0.0.1:18088/healthz")).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("gateway did not start");
}

before(async () => {
  await listen(4000);
  await listen(33656);
  gateway = spawn(process.execPath, [gatewayPath], {
    env: { ...process.env, NURI_GATEWAY_PORT: "18088" },
    stdio: "ignore",
  });
  await waitForGateway();
});

after(async () => {
  gateway.kill("SIGTERM");
  await Promise.all(
    upstreams.map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

test("strips the Api prefix and streams the request body", async () => {
  const response = await fetch("http://127.0.0.1:18088/api/ciphers?revision=7", {
    method: "POST",
    body: "encrypted-payload",
  });
  const received = await response.json();
  assert.equal(received.method, "POST");
  assert.equal(received.path, "/ciphers?revision=7");
  assert.equal(received.bodyLength, 17);
  assert.equal(received.forwardedHost, "127.0.0.1:18088");
});

test("preserves the Identity path base", async () => {
  const response = await fetch(
    "http://127.0.0.1:18088/identity/.well-known/openid-configuration",
  );
  const received = await response.json();
  assert.equal(received.path, "/identity/.well-known/openid-configuration");
});

test("exposes only the allowlisted routes", async () => {
  const response = await fetch("http://127.0.0.1:18088/admin");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "route_not_found" });
});
