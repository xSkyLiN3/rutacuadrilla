import { performance } from "node:perf_hooks";

function buildPoints(count) {
  let seed = 42;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 2 ** 32;
  };

  return Array.from({ length: count }, (_, index) => ({
    type: "Feature",
    id: `point-${index + 1}`,
    geometry: {
      type: "Point",
      coordinates: [-0.67 + random() * 0.12, -0.51 + random() * 0.12],
    },
    properties: {
      state: index % 7 === 0 ? "VOLVER" : "SIN_VISITAR",
      street: `Calle ${index % 180}`,
      number: String(100 + (index % 900)),
    },
  }));
}

function gridIndex(features, cellSize = 0.005) {
  const cells = new Map();
  for (const feature of features) {
    const [longitude, latitude] = feature.geometry.coordinates;
    const key = `${Math.floor(longitude / cellSize)}:${Math.floor(latitude / cellSize)}`;
    const bucket = cells.get(key) ?? [];
    bucket.push(feature.id);
    cells.set(key, bucket);
  }
  return cells;
}

function run(count) {
  const heapBefore = process.memoryUsage().heapUsed;
  const buildStarted = performance.now();
  const features = buildPoints(count);
  const geojson = { type: "FeatureCollection", features };
  const buildMs = performance.now() - buildStarted;

  const indexStarted = performance.now();
  const index = gridIndex(features);
  const indexMs = performance.now() - indexStarted;

  const filterStarted = performance.now();
  const pendingCount = features.filter(
    (feature) => feature.properties.state === "SIN_VISITAR",
  ).length;
  const filterMs = performance.now() - filterStarted;
  const serializedBytes = Buffer.byteLength(JSON.stringify(geojson));
  const heapDeltaMiB = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

  return {
    count,
    buildMs: Number(buildMs.toFixed(2)),
    gridIndexMs: Number(indexMs.toFixed(2)),
    filterMs: Number(filterMs.toFixed(2)),
    gridCells: index.size,
    pendingCount,
    serializedMiB: Number((serializedBytes / 1024 / 1024).toFixed(2)),
    heapDeltaMiB: Number(heapDeltaMiB.toFixed(2)),
  };
}

console.log(
  JSON.stringify(
    {
      warning:
        "Mide preparación de datos en Node, no renderizado MapLibre, GPU, interacción móvil ni tamaño de tiles.",
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      results: [1_000, 5_000, 10_000].map(run),
    },
    null,
    2,
  ),
);
