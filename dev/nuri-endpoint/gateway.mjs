import http from "node:http";

const listenHost = process.env.NURI_GATEWAY_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.NURI_GATEWAY_PORT ?? "8088");

const targets = [
  { prefix: "/api", host: "127.0.0.1", port: 4000, stripPrefix: true },
  { prefix: "/identity", host: "127.0.0.1", port: 33656, stripPrefix: false },
];

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function copyHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

function routeFor(pathname) {
  return targets.find(
    ({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://gateway.invalid");

  if (requestUrl.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "nuri-bitwarden-gateway" }));
    return;
  }

  const route = routeFor(requestUrl.pathname);
  if (!route) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "route_not_found" }));
    return;
  }

  const upstreamPathname = route.stripPrefix
    ? requestUrl.pathname.slice(route.prefix.length) || "/"
    : requestUrl.pathname;
  const headers = copyHeaders(request.headers);
  headers["x-forwarded-host"] = request.headers.host ?? "";
  headers["x-forwarded-proto"] = request.headers["x-forwarded-proto"] ?? "http";

  const upstream = http.request(
    {
      host: route.host,
      port: route.port,
      method: request.method,
      path: `${upstreamPathname}${requestUrl.search}`,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        copyHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ error: "upstream_unavailable" }));
  });

  request.pipe(upstream);
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(listenPort, listenHost, () => {
  console.log(`nuri-bitwarden gateway listening on http://${listenHost}:${listenPort}`);
});
