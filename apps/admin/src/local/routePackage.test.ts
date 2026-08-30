import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  LocalPackageError,
  MemoryRoutePackagePersistence,
  ROUTE_PACKAGE_KIND,
  type RoutePackageDownload,
  type RoutePackagePointV1,
  type RoutePackageScope,
  type RoutePackageSegmentV1,
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

function packageFixture(overrides: Partial<RoutePackageV1> = {}): RoutePackageV1 {
  return {
    area: null,
    attributions: [],
    bounds: { east: -0.6, north: -0.4, south: -0.5, west: -0.7 },
    crewId: scope.crewId,
    kind: ROUTE_PACKAGE_KIND,
    points: [
      {
        displayOrder: 0,
        externalId: "home-1",
        id: "point-1",
        latitude: -0.45,
        longitude: -0.65,
        number: "10",
        pointType: "DWELLING",
        servicePointVersionId: "point-version-1",
        source: "CSV",
        street: "Los Aromos",
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
    ...overrides,
  };
}

function pointFixture(): RoutePackagePointV1 {
  const point = packageFixture().points[0];
  if (!point) throw new Error("fixture sin punto");
  return point;
}

function segmentFixture(overrides: Partial<RoutePackageSegmentV1> = {}): RoutePackageSegmentV1 {
  return {
    displayOrder: 0,
    externalId: "way/100",
    geometry: {
      type: "MultiLineString",
      coordinates: [
        [
          [-0.67, -0.44],
          [-0.66, -0.45],
        ],
      ],
    },
    id: "segment-1",
    name: "Calle Compartida",
    serviceSide: "LEFT",
    source: "MANUAL",
    streetSegmentVersionId: "segment-version-1",
    ...overrides,
  };
}

async function downloadFor(value: unknown): Promise<RoutePackageDownload> {
  const body = JSON.stringify(value);
  const sha256 = await sha256Hex(body);
  return {
    body,
    byteLength: new TextEncoder().encode(body).byteLength,
    etag: `"sha256-${sha256}"`,
    sha256,
  };
}

describe("RoutePackageStore", () => {
  it("verifica y conserva una copia al reabrir el repositorio local", async () => {
    const persistence = new MemoryRoutePackagePersistence();
    const firstStore = new RoutePackageStore(
      persistence,
      () => new Date("2026-08-11T13:00:00.000Z"),
    );
    await firstStore.save(scope, await downloadFor(packageFixture()));
    firstStore.close();

    const reopenedStore = new RoutePackageStore(
      persistence,
      () => new Date("2026-08-11T14:00:00.000Z"),
    );
    const restored = await reopenedStore.load(scope);

    expect(restored.package.route.name).toBe("Ruta Uno");
    expect(restored.package.points).toHaveLength(1);
    expect(restored.record.storedAt).toBe("2026-08-11T13:00:00.000Z");
    expect(restored.record.verifiedAt).toBe("2026-08-11T14:00:00.000Z");
  });

  it("conserva geometría y lado operativo de los tramos, y abre paquetes históricos sin ellos", async () => {
    const store = new RoutePackageStore(new MemoryRoutePackagePersistence());
    const area = {
      type: "MultiPolygon" as const,
      coordinates: [
        [
          [
            [-0.68, -0.48] as [number, number],
            [-0.62, -0.48] as [number, number],
            [-0.62, -0.42] as [number, number],
            [-0.68, -0.48] as [number, number],
          ],
        ],
      ],
    };
    await store.save(
      scope,
      await downloadFor(
        packageFixture({ area, segments: [segmentFixture({ serviceSide: "RIGHT" })] }),
      ),
    );

    const restored = await store.load(scope);
    expect(restored.package.area).toEqual(area);
    expect(restored.package.segments).toEqual([
      expect.objectContaining({
        externalId: "way/100",
        geometry: segmentFixture().geometry,
        serviceSide: "RIGHT",
      }),
    ]);

    const historicalScope = { ...scope, revisionId: "revision-historical" };
    const historical = packageFixture({
      revision: { ...packageFixture().revision, id: historicalScope.revisionId },
    }) as Partial<RoutePackageV1>;
    delete historical.segments;
    await store.save(historicalScope, await downloadFor(historical));
    expect((await store.load(historicalScope)).package.segments).toEqual([]);

    const legacySegmentScope = { ...scope, revisionId: "revision-legacy-segment" };
    const legacySegment = { ...segmentFixture() } as Partial<RoutePackageSegmentV1>;
    delete legacySegment.serviceSide;
    const legacySegmentPackage = {
      ...packageFixture(),
      revision: { ...packageFixture().revision, id: legacySegmentScope.revisionId },
      segments: [legacySegment],
    };
    await store.save(legacySegmentScope, await downloadFor(legacySegmentPackage));
    expect((await store.load(legacySegmentScope)).package.segments[0]?.serviceSide).toBe("BOTH");
  });

  it("rechaza lados, geometrías, orden e identidades de tramo inválidos", async () => {
    const store = new RoutePackageStore(new MemoryRoutePackagePersistence());
    const invalidSide = {
      ...packageFixture(),
      segments: [{ ...segmentFixture(), serviceSide: "NEAREST" }],
    };
    await expect(store.save(scope, await downloadFor(invalidSide))).rejects.toMatchObject({
      code: "LOCAL_PACKAGE_INVALID",
    });

    const invalidGeometry = {
      ...packageFixture(),
      segments: [
        {
          ...segmentFixture(),
          geometry: {
            type: "LineString",
            coordinates: [
              [-0.67, -0.44],
              [-0.66, -0.45],
            ],
          },
        },
      ],
    };
    await expect(store.save(scope, await downloadFor(invalidGeometry))).rejects.toMatchObject({
      code: "LOCAL_PACKAGE_INVALID",
    });

    const wrongOrder = packageFixture({
      segments: [segmentFixture({ displayOrder: 2 })],
    });
    await expect(store.save(scope, await downloadFor(wrongOrder))).rejects.toMatchObject({
      code: "LOCAL_PACKAGE_INVALID",
    });

    const duplicateIdentity = packageFixture({
      segments: [segmentFixture(), segmentFixture({ displayOrder: 1 })],
    });
    await expect(store.save(scope, await downloadFor(duplicateIdentity))).rejects.toMatchObject({
      code: "LOCAL_PACKAGE_INVALID",
    });

    const openArea = {
      ...packageFixture(),
      area: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-0.68, -0.48],
              [-0.62, -0.48],
              [-0.62, -0.42],
              [-0.67, -0.47],
            ],
          ],
        ],
      },
    };
    await expect(store.save(scope, await downloadFor(openArea))).rejects.toMatchObject({
      code: "LOCAL_PACKAGE_INVALID",
    });
  });

  it("permite el mismo externalId de tramo cuando la fuente es distinta", async () => {
    const store = new RoutePackageStore(new MemoryRoutePackagePersistence());
    const value = packageFixture({
      attributions: [
        {
          label: "© OpenStreetMap contributors",
          url: "https://www.openstreetmap.org/copyright",
        },
      ],
      segments: [
        segmentFixture({ externalId: "shared/1", source: "MANUAL" }),
        segmentFixture({
          displayOrder: 1,
          externalId: "shared/1",
          id: "segment-2",
          source: "OSM",
          streetSegmentVersionId: "segment-version-2",
        }),
      ],
    });

    await store.save(scope, await downloadFor(value));

    expect((await store.load(scope)).package.segments).toHaveLength(2);
  });

  it("rechaza el contenido cuando el hash de transporte no coincide", async () => {
    const persistence = new MemoryRoutePackagePersistence();
    const store = new RoutePackageStore(persistence);
    const download = await downloadFor(packageFixture());

    await expect(
      store.save(scope, { ...download, body: download.body.replace("Ruta Uno", "Ruta Dos") }),
    ).rejects.toMatchObject({ code: "LOCAL_PACKAGE_CORRUPT" });
    expect(await persistence.get(scope)).toBeUndefined();
  });

  it("detecta corrupción persistida, la retira y no entrega datos parciales", async () => {
    const persistence = new MemoryRoutePackagePersistence();
    const store = new RoutePackageStore(persistence);
    await store.save(scope, await downloadFor(packageFixture()));
    const record = await persistence.get(scope);
    if (!record) throw new Error("fixture no persistido");
    await persistence.put({ ...record, body: record.body.replace("home-1", "home-X") });

    await expect(store.load(scope)).rejects.toMatchObject({ code: "LOCAL_PACKAGE_CORRUPT" });
    expect(await persistence.get(scope)).toBeUndefined();
  });

  it("aísla por cuenta y tripulación y purga únicamente la cuenta solicitada", async () => {
    const persistence = new MemoryRoutePackagePersistence();
    const store = new RoutePackageStore(persistence);
    await store.save(scope, await downloadFor(packageFixture()));
    const secondScope = { ...scope, accountId: "user-2" };
    await store.save(secondScope, await downloadFor(packageFixture()));

    expect(await store.list("user-1", "crew-1")).toHaveLength(1);
    expect(await store.list("user-1", "crew-2")).toHaveLength(0);
    await store.clearAccount("user-1");

    await expect(store.load(scope)).rejects.toMatchObject({ code: "LOCAL_PACKAGE_NOT_FOUND" });
    expect((await store.load(secondScope)).package.route.id).toBe("route-1");
  });

  it("rechaza un paquete válido firmado para otra identidad", async () => {
    const store = new RoutePackageStore(new MemoryRoutePackagePersistence());
    const foreign = packageFixture({ crewId: "crew-other" });

    await expect(store.save(scope, await downloadFor(foreign))).rejects.toMatchObject({
      code: "LOCAL_PACKAGE_INVALID",
    });
  });

  it("rechaza revisiones mutables, orden no canónico y omisión de atribución OSM", async () => {
    const store = new RoutePackageStore(new MemoryRoutePackagePersistence());
    const draft = {
      ...packageFixture(),
      revision: { ...packageFixture().revision, status: "DRAFT" },
    };
    await expect(store.save(scope, await downloadFor(draft))).rejects.toBeInstanceOf(
      LocalPackageError,
    );

    const wrongOrder = packageFixture({
      points: [{ ...pointFixture(), displayOrder: 2 }],
    });
    await expect(store.save(scope, await downloadFor(wrongOrder))).rejects.toMatchObject({
      code: "LOCAL_PACKAGE_INVALID",
    });

    const missingAttribution = packageFixture({
      points: [{ ...pointFixture(), source: "OSM" }],
    });
    await expect(store.save(scope, await downloadFor(missingAttribution))).rejects.toMatchObject({
      code: "LOCAL_PACKAGE_INVALID",
    });

    const segmentWithoutAttribution = packageFixture({
      segments: [segmentFixture({ source: "OSM" })],
    });
    await expect(
      store.save(scope, await downloadFor(segmentWithoutAttribution)),
    ).rejects.toMatchObject({
      code: "LOCAL_PACKAGE_INVALID",
    });
  });

  it("impide que una misma revisión inmutable cambie su contentHash", async () => {
    const persistence = new MemoryRoutePackagePersistence();
    const store = new RoutePackageStore(persistence);
    await store.save(scope, await downloadFor(packageFixture()));
    const changed = packageFixture({
      revision: { ...packageFixture().revision, contentHash: "b".repeat(64) },
    });

    await expect(store.save(scope, await downloadFor(changed))).rejects.toMatchObject({
      code: "LOCAL_PACKAGE_IDENTITY_CHANGED",
    });
    expect((await store.load(scope)).package.revision.contentHash).toBe("a".repeat(64));
  });

  it("conserva los 10.000 puntos del perfil de volumen sin truncarlos", async () => {
    const points = Array.from({ length: 10_000 }, (_, index) => ({
      ...pointFixture(),
      displayOrder: index,
      externalId: `home-${index}`,
      id: `point-${index}`,
      servicePointVersionId: `point-version-${index}`,
    }));
    const routePackage = packageFixture({
      points,
      revision: { ...packageFixture().revision, pointCount: points.length },
    });
    const store = new RoutePackageStore(new MemoryRoutePackagePersistence());

    const saved = await store.save(scope, await downloadFor(routePackage));

    expect(saved.package.points).toHaveLength(10_000);
    expect(saved.package.points.at(-1)?.externalId).toBe("home-9999");
    expect(saved.record.byteLength).toBeGreaterThan(1_000_000);
  });
});
