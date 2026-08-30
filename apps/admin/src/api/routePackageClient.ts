import { MAX_ROUTE_PACKAGE_BYTES, type RoutePackageDownload } from "../local/routePackage";

export const ROUTE_PACKAGE_ACCEPT = "application/vnd.rutacuadrilla.route-package+json; version=1";

export type RoutePackageDownloadRequest = {
  baseUrl: string;
  crewId: string;
  etag?: string;
  revisionId: string;
  routeId: string;
  token: string;
};

export type RoutePackageDownloadResult =
  | { download: RoutePackageDownload; status: "DOWNLOADED" }
  | { etag: string; status: "NOT_MODIFIED" };

export class RoutePackageDownloadError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "RoutePackageDownloadError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

function packageUrl(request: RoutePackageDownloadRequest): string {
  return (
    request.baseUrl.replace(/\/+$/, "") +
    "/api/crews/" +
    encodeURIComponent(request.crewId) +
    "/routes/" +
    encodeURIComponent(request.routeId) +
    "/revisions/" +
    encodeURIComponent(request.revisionId) +
    "/package"
  );
}

function errorMessage(status: number): string {
  if (status === 401) return "La sesión no es válida o expiró.";
  if (status === 403) return "No tienes permisos para preparar esta copia local.";
  if (status === 404) return "La revisión solicitada no existe.";
  if (status === 409) return "Solo puede prepararse una revisión publicada e inmutable.";
  return "No fue posible descargar la copia local de la ruta.";
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) {
    throw new RoutePackageDownloadError(
      502,
      `El servidor omitió el encabezado de integridad ${name}.`,
      "INVALID_PACKAGE_RESPONSE",
    );
  }
  return value;
}

export async function downloadRoutePackage(
  request: RoutePackageDownloadRequest,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RoutePackageDownloadResult> {
  const headers = new Headers({
    Accept: ROUTE_PACKAGE_ACCEPT,
    Authorization: `Bearer ${request.token}`,
  });
  if (request.etag) headers.set("If-None-Match", request.etag);

  let response: Response;
  try {
    response = await fetcher(packageUrl(request), {
      cache: "no-store",
      credentials: "omit",
      headers,
      method: "GET",
    });
  } catch {
    throw new RoutePackageDownloadError(
      0,
      "No fue posible conectar con el servidor para preparar la copia local.",
    );
  }

  if (response.status === 304) {
    const etag = request.etag ?? response.headers.get("ETag");
    if (!etag) {
      throw new RoutePackageDownloadError(
        502,
        "El servidor respondió sin una copia ni un identificador reutilizable.",
        "INVALID_PACKAGE_RESPONSE",
      );
    }
    return { etag, status: "NOT_MODIFIED" };
  }

  if (!response.ok) {
    let code: string | undefined;
    try {
      const payload = (await response.json()) as { code?: unknown };
      if (typeof payload.code === "string") code = payload.code;
    } catch {
      // La respuesta de error no se muestra directamente para evitar filtrar detalles internos.
    }
    throw new RoutePackageDownloadError(response.status, errorMessage(response.status), code);
  }

  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/vnd.rutacuadrilla.route-package+json")) {
    throw new RoutePackageDownloadError(
      502,
      "El servidor respondió con un formato de paquete inesperado.",
      "INVALID_PACKAGE_RESPONSE",
    );
  }

  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null && Number(declaredLength) > MAX_ROUTE_PACKAGE_BYTES) {
    throw new RoutePackageDownloadError(
      413,
      "El paquete supera el límite local de 25 MB.",
      "PACKAGE_TOO_LARGE",
    );
  }
  const body = await response.text();
  const byteLength = new TextEncoder().encode(body).byteLength;
  if (byteLength > MAX_ROUTE_PACKAGE_BYTES) {
    throw new RoutePackageDownloadError(
      413,
      "El paquete supera el límite local de 25 MB.",
      "PACKAGE_TOO_LARGE",
    );
  }
  if (declaredLength !== null && Number(declaredLength) !== byteLength) {
    throw new RoutePackageDownloadError(
      502,
      "El tamaño descargado no coincide con el anunciado por el servidor.",
      "INVALID_PACKAGE_RESPONSE",
    );
  }

  return {
    download: {
      body,
      byteLength,
      etag: requiredHeader(response, "ETag"),
      sha256: requiredHeader(response, "X-Package-SHA256"),
    },
    status: "DOWNLOADED",
  };
}
