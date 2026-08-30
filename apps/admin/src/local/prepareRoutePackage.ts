import type { RoutePackageDownloadResult } from "../api/routePackageClient";
import {
  LocalPackageError,
  type RoutePackageScope,
  type RoutePackageStore,
  type VerifiedRoutePackage,
} from "./routePackage";

export type DownloadRoutePackage = (
  crewId: string,
  routeId: string,
  revisionId: string,
  etag?: string,
) => Promise<RoutePackageDownloadResult>;

export type PrepareRoutePackageResult = VerifiedRoutePackage & {
  source: "DOWNLOADED" | "LOCAL_CURRENT";
};

export async function prepareRoutePackage(
  store: RoutePackageStore,
  scope: RoutePackageScope,
  download: DownloadRoutePackage,
): Promise<PrepareRoutePackageResult> {
  let existing: VerifiedRoutePackage | undefined;
  try {
    existing = await store.find(scope);
  } catch (error) {
    if (!(error instanceof LocalPackageError) || error.code !== "LOCAL_PACKAGE_CORRUPT") {
      throw error;
    }
  }

  let result = await download(scope.crewId, scope.routeId, scope.revisionId, existing?.record.etag);
  if (result.status === "NOT_MODIFIED") {
    if (existing && result.etag === existing.record.etag) {
      return { ...existing, source: "LOCAL_CURRENT" };
    }
    result = await download(scope.crewId, scope.routeId, scope.revisionId);
    if (result.status === "NOT_MODIFIED") {
      throw new LocalPackageError(
        "LOCAL_PACKAGE_INVALID",
        "El servidor no entregó el paquete necesario para reparar la copia local.",
      );
    }
  }

  return {
    ...(await store.save(scope, result.download)),
    source: "DOWNLOADED",
  };
}
