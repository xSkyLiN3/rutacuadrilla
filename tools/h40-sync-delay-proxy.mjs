import http from "node:http";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4313;
const MAX_DELAY_MS = 120_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SYNC_COMMAND_PATH = /^\/api\/crews\/[^/]+\/sync\/commands$/;

function requireLoopbackUpstream(value) {
  const upstream = new URL(value);
  if (
    upstream.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(upstream.hostname)
  ) {
    throw new Error("H40_PROXY_UPSTREAM_MUST_BE_LOOPBACK_HTTP");
  }
  return upstream;
}
function safeDelay(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DELAY_MS) {
    throw new Error("H40_PROXY_DELAY_OUT_OF_RANGE");
  }
  return value;
}

function sendMinimalError(response, statusCode, code) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ code }));
}

export function createH40DelayProxy({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  upstreamUrl = "http://127.0.0.1:4310",
} = {}) {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("H40_PROXY_MUST_BIND_LOOPBACK");
  }
  const upstream = requireLoopbackUpstream(upstreamUrl);
  let nextDelayMs = null;

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://field-proxy.local");
    if (!requestUrl.pathname.startsWith("/api/")) {
      sendMinimalError(response, 404, "H40_PROXY_API_PATH_REQUIRED");
      return;
    }

    const shouldDelay =
      nextDelayMs !== null &&
      request.method === "POST" &&
      SYNC_COMMAND_PATH.test(requestUrl.pathname);
    const delayMs = shouldDelay ? nextDelayMs : 0;
    if (shouldDelay) nextDelayMs = null;

    const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, upstream);
    const headers = { ...request.headers, host: upstream.host };
    const upstreamRequest = http.request(
      target,
      { headers, method: request.method },
      (upstreamResponse) => {
        const chunks = [];
        let size = 0;
        upstreamResponse.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            upstreamResponse.destroy(new Error("H40_PROXY_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        upstreamResponse.on("end", () => {
          const deliver = () => {
            if (response.destroyed) return;
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            response.end(Buffer.concat(chunks));
          };
          if (delayMs > 0) setTimeout(deliver, delayMs);
          else deliver();
        });
        upstreamResponse.on("error", () => {
          sendMinimalError(response, 502, "H40_PROXY_UPSTREAM_RESPONSE_FAILED");
        });
      },
    );
    upstreamRequest.on("error", () => {
      sendMinimalError(response, 502, "H40_PROXY_UPSTREAM_UNAVAILABLE");
    });
    request.pipe(upstreamRequest);
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return {
    address() {
      return server.address();
    },
    arm(delayMs) {
      nextDelayMs = safeDelay(delayMs);
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    disarm() {
      nextDelayMs = null;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    status() {
      return { armed: nextDelayMs !== null, delayMs: nextDelayMs };
    },
  };
}

async function runCli() {
  const proxyPort = Number.parseInt(process.env.H40_PROXY_PORT ?? `${DEFAULT_PORT}`, 10);
  const proxy = createH40DelayProxy({
    port: proxyPort,
    upstreamUrl: process.env.H40_UPSTREAM_URL ?? "http://127.0.0.1:4310",
  });
  const address = await proxy.listen();
  const printableAddress = typeof address === "object" && address ? address.port : proxyPort;
  console.info(`Proxy H40 listo en 127.0.0.1:${printableAddress}.`);
  console.info("Comandos: arm <milisegundos>, disarm, status, quit.");

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  terminal.on("line", async (line) => {
    const [command, argument] = line.trim().split(/\s+/, 2);
    try {
      if (command === "arm") {
        proxy.arm(Number.parseInt(argument ?? "", 10));
        console.info(`La próxima respuesta de sync se retrasará ${proxy.status().delayMs} ms.`);
      } else if (command === "disarm") {
        proxy.disarm();
        console.info("Retardo desarmado.");
      } else if (command === "status") {
        const state = proxy.status();
        console.info(state.armed ? `Armado: ${state.delayMs} ms.` : "Sin retardo armado.");
      } else if (command === "quit") {
        terminal.close();
        await proxy.close();
      } else if (command) {
        console.info("Comando no reconocido.");
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : "H40_PROXY_COMMAND_FAILED");
    }
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : "H40_PROXY_START_FAILED");
    process.exitCode = 1;
  });
}
