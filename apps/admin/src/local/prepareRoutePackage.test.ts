import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareRoutePackage } from "./prepareRoutePackage";
import {
  MemoryRoutePackagePersistence,
  ROUTE_PACKAGE_KIND,
  type RoutePackageDownload,
  type RoutePackageScope,
  RoutePackageStore,
  type RoutePackageV1,
  sha256Hex,
} from "./routePackage";

const scope: RoutePackageScope = {
  accountId: "user-1",
  crewId: "crew-1",
  revisionId: "revision-1",
  routeId: "route-1",
};

beforeAll(() => {
  vi.stubGlobal("crypto", webcrypto);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function routePackage(): RoutePackageV1 {
  return {
    area: null,
    attributions: [],
    bounds: { east: 1, north: 1, south: -1, west: -1 },
    crewId: scope.crewId,
    kind: ROUTE_PACKAGE_KIND,
    points: [
      {
        displayOrder: 0,
        externalId: "point-1",
        id: "point-1",
        latitude: -0.5,
        longitude: -0.5,
        pointType: "DWELLING",
        servicePointVersionId: "point-version-1",
        source: "CSV",
      },
    ],
    revision: {
      contentHash: "a".repeat(64),
      id: scope.revisionId,
      number: 1,
      pointCount: 1,
      publishedAt: "2026-08-11T12:00:00.000Z",
      status: "PUBLISHED",
    },
    route: { id: scope.routeId, name: "Ruta Uno", sectorName: "Sector Uno" },
    schemaVersion: 1,
    segments: [],
  };
}

async function downloadFixture(): Promise<RoutePackageDownload> {
  const body = JSON.stringify(routePackage());
  const sha256 = await sha256Hex(body);
  return {
    body,
    byteLength: new TextEncoder().encode(body).byteLength,
    etag: `"sha256-${sha256}"`,
    sha256,
  };
}

describe("prepareRoutePackage", () => {
  it("descarga, verifica y persiste cuando no existe copia", async () => {
    const store = new RoutePackageStore(new MemoryRoutePackagePersistence());
    const download = await downloadFixture();
    const request = vi.fn().mockResolvedValue({ download, status: "DOWNLOADED" });

    const result = await prepareRoutePackage(store, scope, request);

    expect(result.source).toBe("DOWNLOADED");
    expect(result.package.points).toHaveLength(1);
    expect(request).toHaveBeenCalledWith("crew-1", "route-1", "revision-1", undefined);
    await expect(store.load(scope)).resolves.toMatchObject({
      package: { crewId: "crew-1" },
    });
  });

  it("revalida por ETag y reutiliza únicamente una copia local verificada", async () => {
    const store = new RoutePackageStore(new MemoryRoutePackagePersistence());
    const download = await downloadFixture();
    await store.save(scope, download);
    const request = vi.fn().mockResolvedValue({ etag: download.etag, status: "NOT_MODIFIED" });

    const result = await prepareRoutePackage(store, scope, request);

    expect(result.source).toBe("LOCAL_CURRENT");
    expect(request).toHaveBeenCalledWith("crew-1", "route-1", "revision-1", download.etag);
  });

  it("reintenta sin ETag si recibe 304 pero perdió la copia local", async () => {
    const store = new RoutePackageStore(new MemoryRoutePackagePersistence());
    const download = await downloadFixture();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ etag: download.etag, status: "NOT_MODIFIED" })
      .mockResolvedValueOnce({ download, status: "DOWNLOADED" });

    const result = await prepareRoutePackage(store, scope, request);

    expect(result.source).toBe("DOWNLOADED");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]).toEqual(["crew-1", "route-1", "revision-1"]);
  });
});
