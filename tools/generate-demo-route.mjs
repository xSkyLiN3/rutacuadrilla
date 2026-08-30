import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(import.meta.dirname, "..");

export const DEMO_ROUTE_SEED = "rutacuadrilla-public-synthetic-v1";
export const DEMO_ARTIFACT_PATHS = Object.freeze({
  area: "demo/area.geojson",
  dwellings: "apps/field/public/demo-dwellings.geojson",
  manifest: "demo/manifest.json",
  parcels: "apps/field/public/demo-parcels.geojson",
  route: "demo/route.csv",
  segments: "demo/segments.json",
});

const streetNames = [
  "Pasaje Aurora Cero",
  "Calle Bruma Digital",
  "Sendero Cobalto Norte",
  "Avenida Horizonte Beta",
  "Pasaje Lumen Sur",
  "Calle Nébula Clara",
  "Sendero Prisma Uno",
  "Avenida Quimera Este",
  "Pasaje Solaris Dos",
  "Calle Vértice Azul",
  "Sendero Zafiro Cero",
  "Avenida Órbita Demo",
];

const serviceSides = ["LEFT", "RIGHT", "BOTH"];

function coordinate(value) {
  return Number(value.toFixed(7));
}

function rectangle(longitude, latitude, halfWidth, halfHeight) {
  const west = coordinate(longitude - halfWidth);
  const east = coordinate(longitude + halfWidth);
  const south = coordinate(latitude - halfHeight);
  const north = coordinate(latitude + halfHeight);
  return {
    type: "Polygon",
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function buildDemoRouteData() {
  const points = [];
  const segments = streetNames.map((name, segmentIndex) => {
    const latitude = coordinate(-0.00275 + segmentIndex * 0.0005);
    const serviceSide = serviceSides[segmentIndex % serviceSides.length];

    for (let pointIndex = 0; pointIndex < 6; pointIndex += 1) {
      const sequence = segmentIndex * 6 + pointIndex + 1;
      const longitude = coordinate(-0.00125 + pointIndex * 0.0005);
      const side =
        serviceSide === "LEFT" ? 1 : serviceSide === "RIGHT" ? -1 : pointIndex % 2 === 0 ? 1 : -1;
      const pointLatitude = coordinate(latitude + side * 0.00013);
      points.push({
        externalId: `synthetic/dwelling/${String(sequence).padStart(3, "0")}`,
        latitude: pointLatitude,
        longitude,
        number: String((segmentIndex + 1) * 100 + (pointIndex + 1) * 2),
        pointType: "DWELLING",
        source: "GEOJSON",
        street: name,
      });
    }

    return {
      attribution: "Datos sintéticos de demostración; no representan ubicaciones reales.",
      externalId: `synthetic/segment/${String(segmentIndex + 1).padStart(2, "0")}`,
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-0.00155, latitude],
            [0.00155, latitude],
          ],
        ],
      },
      name,
      serviceSide,
      source: "GEOJSON",
      sourceVersion: "synthetic-v1",
    };
  });

  const parcels = {
    type: "FeatureCollection",
    metadata: {
      synthetic: true,
      seed: DEMO_ROUTE_SEED,
      description: "Predios ficticios generados para la demostración pública de RutaCuadrilla.",
    },
    features: points.map((point) => ({
      type: "Feature",
      properties: { externalId: point.externalId, synthetic: true },
      geometry: rectangle(point.longitude, point.latitude, 0.00015, 0.00008),
    })),
  };

  const dwellings = {
    type: "FeatureCollection",
    metadata: {
      synthetic: true,
      seed: DEMO_ROUTE_SEED,
      description: "Huellas ficticias generadas para la demostración pública de RutaCuadrilla.",
    },
    features: points.map((point) => ({
      type: "Feature",
      properties: { externalId: point.externalId, synthetic: true },
      geometry: rectangle(point.longitude, point.latitude, 0.000075, 0.00004),
    })),
  };

  const area = {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [-0.00175, -0.00315],
          [0.00175, -0.00315],
          [0.00175, 0.00315],
          [-0.00175, 0.00315],
          [-0.00175, -0.00315],
        ],
      ],
    ],
  };

  return { area, dwellings, parcels, points, segments };
}

function routeCsv(points) {
  const header = "external_id,street,number,latitude,longitude,point_type,source";
  const rows = points.map((point) =>
    [
      point.externalId,
      point.street,
      point.number,
      point.latitude.toFixed(7),
      point.longitude.toFixed(7),
      point.pointType,
      point.source,
    ].join(","),
  );
  return `${[header, ...rows].join("\n")}\n`;
}

export function createDemoRouteArtifacts() {
  const data = buildDemoRouteData();
  const content = {
    [DEMO_ARTIFACT_PATHS.area]: json(data.area),
    [DEMO_ARTIFACT_PATHS.dwellings]: json(data.dwellings),
    [DEMO_ARTIFACT_PATHS.parcels]: json(data.parcels),
    [DEMO_ARTIFACT_PATHS.route]: routeCsv(data.points),
    [DEMO_ARTIFACT_PATHS.segments]: json(data.segments),
  };
  const hashes = Object.fromEntries(
    Object.entries(content).map(([path, value]) => [path, sha256(value)]),
  );
  const manifest = {
    schemaVersion: 1,
    id: "ruta-demo-sintetica-v1",
    name: "Ruta Demo Horizonte",
    sectorName: "Distrito Demo Cero",
    description:
      "Dataset determinístico completamente ficticio; no representa calles, predios, viviendas ni personas reales.",
    synthetic: true,
    seed: DEMO_ROUTE_SEED,
    origin: [0, 0],
    coordinateReferenceSystem: "WGS84",
    counts: {
      points: data.points.length,
      segments: data.segments.length,
      parcels: data.parcels.features.length,
      dwellings: data.dwellings.features.length,
    },
    files: {
      area: DEMO_ARTIFACT_PATHS.area,
      dwellings: DEMO_ARTIFACT_PATHS.dwellings,
      parcels: DEMO_ARTIFACT_PATHS.parcels,
      route: DEMO_ARTIFACT_PATHS.route,
      segments: DEMO_ARTIFACT_PATHS.segments,
    },
    sha256: hashes,
  };
  return { ...content, [DEMO_ARTIFACT_PATHS.manifest]: json(manifest) };
}

export async function writeDemoRouteArtifacts() {
  const artifacts = createDemoRouteArtifacts();
  for (const [relativePath, content] of Object.entries(artifacts)) {
    const outputPath = resolve(projectRoot, relativePath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, "utf8");
  }
  return artifacts;
}

export async function checkDemoRouteArtifacts() {
  const artifacts = createDemoRouteArtifacts();
  const stale = [];
  for (const [relativePath, expected] of Object.entries(artifacts)) {
    try {
      const actual = await readFile(resolve(projectRoot, relativePath), "utf8");
      if (actual !== expected) stale.push(relativePath);
    } catch {
      stale.push(relativePath);
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `Artefactos demo ausentes o desactualizados: ${stale.join(", ")}. Ejecuta con --write.`,
    );
  }
  return artifacts;
}

async function main() {
  const argumentsSet = new Set(process.argv.slice(2));
  const unknown = [...argumentsSet].filter(
    (argument) => !["--check", "--write"].includes(argument),
  );
  if (unknown.length > 0) throw new Error(`Argumento desconocido: ${unknown.join(", ")}`);
  if (argumentsSet.has("--check") && argumentsSet.has("--write")) {
    throw new Error("Usa --check o --write, no ambos.");
  }

  const artifacts = argumentsSet.has("--write")
    ? await writeDemoRouteArtifacts()
    : await checkDemoRouteArtifacts();
  const manifest = JSON.parse(artifacts[DEMO_ARTIFACT_PATHS.manifest]);
  process.stdout.write(
    `${JSON.stringify({
      action: argumentsSet.has("--write") ? "write" : "check",
      points: manifest.counts.points,
      segments: manifest.counts.segments,
      synthetic: manifest.synthetic,
      valid: true,
    })}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
