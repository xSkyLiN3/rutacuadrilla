import { readFile, realpath, stat } from "node:fs/promises";
import http from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function baseHeaders(pathname) {
  const mutableShell =
    pathname === "/" || pathname === "/index.html" || pathname === "/field-sw.js";
  return {
    "cache-control": mutableShell ? "no-cache" : "public, max-age=31536000, immutable",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "service-worker-allowed": "/",
    "x-content-type-options": "nosniff",
  };
}

function isInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function resolveArtifactFile(root, request) {
  const url = new URL(request.url ?? "/", "http://field-artifact.local");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new Error("H40_ARTIFACT_REQUEST_PATH_INVALID");
  }
  if (pathname.includes("\0") || pathname.includes("\\")) {
    throw new Error("H40_ARTIFACT_REQUEST_PATH_INVALID");
  }
  const relativePath = pathname.replace(/^\/+/, "");
  let candidate = resolve(root, relativePath || "index.html");
  if (!isInside(root, candidate)) throw new Error("H40_ARTIFACT_REQUEST_OUTSIDE_ROOT");

  try {
    const info = await stat(candidate);
    if (info.isDirectory()) candidate = resolve(candidate, "index.html");
  } catch {
    const acceptsHtml = (request.headers.accept ?? "").includes("text/html");
    if (request.method === "GET" && acceptsHtml && extname(pathname) === "") {
      candidate = resolve(root, "index.html");
    } else {
      return null;
    }
  }

  const physical = await realpath(candidate).catch(() => null);
  if (!physical || !isInside(root, physical)) return null;
  const info = await stat(physical);
  return info.isFile() ? { path: physical, pathname } : null;
}

export async function createH40ArtifactServer({ directory, host = "127.0.0.1", port = 4312 }) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("H40_ARTIFACT_SERVER_MUST_BIND_LOOPBACK");
  if (!isAbsolute(directory)) throw new Error("H40_ARTIFACT_DIRECTORY_MUST_BE_ABSOLUTE");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("H40_ARTIFACT_PORT_INVALID");
  }
  const root = await realpath(directory);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error("H40_ARTIFACT_DIRECTORY_INVALID");
  const indexInfo = await stat(resolve(root, "index.html")).catch(() => null);
  if (!indexInfo?.isFile()) throw new Error("H40_ARTIFACT_INDEX_MISSING");

  const server = http.createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { ...baseHeaders("/"), allow: "GET, HEAD" });
      response.end();
      return;
    }
    try {
      const file = await resolveArtifactFile(root, request);
      if (!file) {
        response.writeHead(404, baseHeaders("/"));
        response.end();
        return;
      }
      const body = await readFile(file.path);
      response.writeHead(200, {
        ...baseHeaders(file.pathname),
        "content-length": String(body.length),
        "content-type":
          MIME_TYPES.get(extname(file.path).toLowerCase()) ?? "application/octet-stream",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(400, baseHeaders("/"));
      response.end();
    }
  });

  return {
    address() {
      return server.address();
    },
    close() {
      return new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    },
    listen() {
      return new Promise((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(port, host, () => {
          server.off("error", rejectPromise);
          resolvePromise(server.address());
        });
      });
    },
  };
}

async function runCli() {
  const directory = process.argv[2];
  if (!directory) {
    throw new Error("Uso: node tools/serve-h40-field-artifact.mjs <directorio-absoluto>");
  }
  const port = Number.parseInt(process.env.H40_FIELD_PORT ?? "4312", 10);
  const artifactServer = await createH40ArtifactServer({ directory, port });
  const address = await artifactServer.listen();
  const printablePort = typeof address === "object" && address ? address.port : port;
  console.info(`Artefacto Campo H40 listo en 127.0.0.1:${printablePort}.`);
  const stop = async () => {
    await artifactServer.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : "H40_ARTIFACT_SERVER_FAILED");
    process.exitCode = 1;
  });
}
