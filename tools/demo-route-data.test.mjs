import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  createDemoRouteArtifacts,
  DEMO_ARTIFACT_PATHS,
  DEMO_ROUTE_SEED,
} from "./generate-demo-route.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

function parseCsv(value) {
  const [header, ...rows] = value.trim().split("\n");
  assert.equal(header, "external_id,street,number,latitude,longitude,point_type,source");
  return rows.map((row) => {
    const [externalId, street, number, latitude, longitude, pointType, source] = row.split(",");
    return {
      externalId,
      latitude: Number(latitude),
      longitude: Number(longitude),
      number,
      pointType,
      source,
      street,
    };
  });
}

function bounds(feature) {
  const ring = feature.geometry.coordinates[0];
  return {
    east: Math.max(...ring.map(([longitude]) => longitude)),
    north: Math.max(...ring.map(([, latitude]) => latitude)),
    south: Math.min(...ring.map(([, latitude]) => latitude)),
    west: Math.min(...ring.map(([longitude]) => longitude)),
  };
}

function contains(box, point) {
  return (
    point.longitude >= box.west &&
    point.longitude <= box.east &&
    point.latitude >= box.south &&
    point.latitude <= box.north
  );
}

describe("public synthetic demo route", () => {
  it("is deterministic and matches every generated artifact on disk", async () => {
    const first = createDemoRouteArtifacts();
    const second = createDemoRouteArtifacts();
    assert.deepEqual(first, second);

    for (const [relativePath, expected] of Object.entries(first)) {
      assert.equal(await readFile(resolve(projectRoot, relativePath), "utf8"), expected);
    }
  });

  it("declares its synthetic origin and immutable artifact hashes", () => {
    const artifacts = createDemoRouteArtifacts();
    const manifest = JSON.parse(artifacts[DEMO_ARTIFACT_PATHS.manifest]);
    assert.equal(manifest.synthetic, true);
    assert.equal(manifest.seed, DEMO_ROUTE_SEED);
    assert.deepEqual(manifest.origin, [0, 0]);
    assert.deepEqual(manifest.counts, {
      points: 72,
      segments: 12,
      parcels: 72,
      dwellings: 72,
    });

    for (const [relativePath, expectedHash] of Object.entries(manifest.sha256)) {
      assert.equal(
        createHash("sha256").update(artifacts[relativePath]).digest("hex"),
        expectedHash,
      );
    }
  });

  it("contains 72 fictitious points and 12 segments using every service-side mode", () => {
    const artifacts = createDemoRouteArtifacts();
    const points = parseCsv(artifacts[DEMO_ARTIFACT_PATHS.route]);
    const segments = JSON.parse(artifacts[DEMO_ARTIFACT_PATHS.segments]);

    assert.equal(points.length, 72);
    assert.equal(new Set(points.map((point) => point.externalId)).size, 72);
    assert.ok(points.every((point) => point.externalId.startsWith("synthetic/dwelling/")));
    assert.ok(points.every((point) => point.source === "GEOJSON"));
    assert.ok(points.every((point) => point.pointType === "DWELLING"));
    assert.ok(
      points.every((point) => Math.abs(point.latitude) < 0.01 && Math.abs(point.longitude) < 0.01),
    );
    assert.equal(segments.length, 12);
    assert.equal(new Set(segments.map((segment) => segment.externalId)).size, 12);
    assert.deepEqual(
      new Set(segments.map((segment) => segment.serviceSide)),
      new Set(["LEFT", "RIGHT", "BOTH"]),
    );
    assert.ok(segments.every((segment) => segment.source === "GEOJSON"));
    assert.ok(segments.every((segment) => segment.externalId.startsWith("synthetic/segment/")));

    for (const segment of segments) {
      const streetPoints = points.filter((point) => point.street === segment.name);
      const centerLatitude = segment.geometry.coordinates[0][0][1];
      const leftCount = streetPoints.filter((point) => point.latitude > centerLatitude).length;
      const rightCount = streetPoints.filter((point) => point.latitude < centerLatitude).length;
      assert.equal(streetPoints.length, 6);
      if (segment.serviceSide === "LEFT") assert.deepEqual([leftCount, rightCount], [6, 0]);
      if (segment.serviceSide === "RIGHT") assert.deepEqual([leftCount, rightCount], [0, 6]);
      if (segment.serviceSide === "BOTH") assert.deepEqual([leftCount, rightCount], [3, 3]);
    }
  });

  it("keeps a strict 1:1 point, parcel and dwelling-footprint relationship", () => {
    const artifacts = createDemoRouteArtifacts();
    const points = parseCsv(artifacts[DEMO_ARTIFACT_PATHS.route]);
    const parcels = JSON.parse(artifacts[DEMO_ARTIFACT_PATHS.parcels]);
    const dwellings = JSON.parse(artifacts[DEMO_ARTIFACT_PATHS.dwellings]);
    const pointIds = new Set(points.map((point) => point.externalId));
    const parcelsById = new Map(
      parcels.features.map((feature) => [feature.properties.externalId, feature]),
    );
    const dwellingsById = new Map(
      dwellings.features.map((feature) => [feature.properties.externalId, feature]),
    );

    assert.equal(parcels.metadata.synthetic, true);
    assert.equal(dwellings.metadata.synthetic, true);
    assert.equal(parcelsById.size, 72);
    assert.equal(dwellingsById.size, 72);
    assert.deepEqual(new Set(parcelsById.keys()), pointIds);
    assert.deepEqual(new Set(dwellingsById.keys()), pointIds);

    for (const point of points) {
      const parcelBox = bounds(parcelsById.get(point.externalId));
      const dwellingBox = bounds(dwellingsById.get(point.externalId));
      assert.ok(contains(parcelBox, point), `${point.externalId} está fuera de su predio`);
      assert.ok(contains(dwellingBox, point), `${point.externalId} está fuera de su huella`);
      assert.ok(dwellingBox.west > parcelBox.west && dwellingBox.east < parcelBox.east);
      assert.ok(dwellingBox.south > parcelBox.south && dwellingBox.north < parcelBox.north);
    }
  });

  it("audits every artifact consumed by the idempotent demo importer", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      resolve(projectRoot, "tools", "import-demo-route.mjs"),
      "--audit",
    ]);
    assert.deepEqual(JSON.parse(stdout), {
      action: "audit",
      area: true,
      applyRequired: "Inicia la API y vuelve a ejecutar con --apply.",
      points: 72,
      route: "Ruta Demo Horizonte",
      segments: 12,
      synthetic: true,
      valid: true,
    });
  });
});
