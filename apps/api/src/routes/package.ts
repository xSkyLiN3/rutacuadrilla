import { createHash } from "node:crypto";

export const ROUTE_PACKAGE_MEDIA_TYPE =
  "application/vnd.rutacuadrilla.route-package+json; version=1";

export type RoutePackageRepresentation = {
  body: string;
  byteLength: number;
  etag: string;
  sha256: string;
};

export function routePackageHeaders(
  representation: RoutePackageRepresentation,
): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    "Content-Length": String(representation.byteLength),
    "Content-Type": ROUTE_PACKAGE_MEDIA_TYPE,
    ETag: representation.etag,
    Vary: "Authorization",
    "X-Package-SHA256": representation.sha256,
  };
}

export function routePackageNotModifiedHeaders(
  representation: RoutePackageRepresentation,
): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    ETag: representation.etag,
    Vary: "Authorization",
  };
}

export function representRoutePackage(routePackage: unknown): RoutePackageRepresentation {
  const body = JSON.stringify(routePackage);
  if (body === undefined) {
    throw new TypeError("Route package must be JSON serializable");
  }
  const bytes = Buffer.from(body, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    body,
    byteLength: bytes.byteLength,
    etag: `"sha256-${sha256}"`,
    sha256,
  };
}

export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag);
}
