import { Buffer } from "node:buffer";
import { canonicalHash, canonicalJson } from "./geometry.js";
import type { RoutePackageDto } from "./types.js";

export type SerializedRoutePackage = {
  body: string;
  byteLength: number;
  etag: string;
  sha256: string;
};

export function serializeRoutePackage(routePackage: RoutePackageDto): SerializedRoutePackage {
  const body = canonicalJson(routePackage);
  const sha256 = canonicalHash(routePackage);
  return {
    body,
    byteLength: Buffer.byteLength(body, "utf8"),
    etag: `"sha256-${sha256}"`,
    sha256,
  };
}
