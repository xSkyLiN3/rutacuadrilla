import { describe, expect, it } from "vitest";
import type { FieldPoint, FieldSegment } from "../types";
import {
  buildFieldPointCollection,
  buildFieldSegmentCollection,
  fieldBounds,
  findNearestFieldPointId,
} from "./fieldGeojson";

describe("buildFieldPointCollection", () => {
  it("genera una fuente única de 10.000 puntos con identificadores interactivos estables", () => {
    const points: FieldPoint[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `point-${index}`,
      externalId: `external-${index}`,
      displayOrder: index,
      latitude: -0.5 + (index % 100) / 10_000,
      longitude: -0.7 + Math.floor(index / 100) / 10_000,
      pointType: "DWELLING",
      state: index % 2 === 0 ? "SIN_VISITAR" : "VOLVER",
      version: 0,
    }));

    const result = buildFieldPointCollection(points);

    expect(result.features).toHaveLength(10_000);
    expect(result.features[9_999]?.id).toBe(9_999);
    expect(result.features[9_999]?.properties.pointId).toBe("point-9999");
    expect(result.features[9_999]?.properties.state).toBe("VOLVER");
    expect(result.features[9_999]?.properties.label).toBe("10000");
  });

  it("elige la vivienda más cercana dentro de un objetivo táctil amplio", () => {
    const points = [
      { id: "uuid-a", latitude: 10, longitude: 10 },
      { id: "uuid-b", latitude: 14, longitude: 13 },
      { id: "uuid-c", latitude: 80, longitude: 80 },
    ];

    expect(findNearestFieldPointId(points, ([x, y]) => ({ x, y }), { x: 14, y: 15 })).toBe(
      "uuid-b",
    );
    expect(
      findNearestFieldPointId(points, ([x, y]) => ({ x, y }), { x: 200, y: 200 }),
    ).toBeUndefined();
  });
});

describe("buildFieldSegmentCollection", () => {
  const segments: FieldSegment[] = [
    {
      id: "segment-left",
      externalId: "osm-way-1",
      displayOrder: 0,
      streetSegmentVersionId: "segment-version-1",
      name: "Los Aromos",
      serviceSide: "LEFT",
      source: "OSM",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-0.67, -0.45],
            [-0.66, -0.44],
          ],
        ],
      },
    },
    {
      id: "segment-both",
      externalId: "manual-2",
      displayOrder: 1,
      streetSegmentVersionId: "segment-version-2",
      serviceSide: "BOTH",
      source: "MANUAL",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-0.68, -0.46],
            [-0.69, -0.47],
          ],
        ],
      },
    },
  ];

  it("expone el lado declarado sin asociarlo a puntos cercanos", () => {
    const collection = buildFieldSegmentCollection(segments);

    expect(collection.features.map((feature) => feature.properties.serviceSide)).toEqual([
      "LEFT",
      "BOTH",
    ]);
    expect(collection.features.map((feature) => feature.properties.segmentId)).toEqual([
      "segment-left",
      "segment-both",
    ]);
    expect(collection.features[0]?.geometry.coordinates[0]).toEqual([
      [-0.67, -0.45],
      [-0.66, -0.44],
    ]);
  });

  it("incluye los tramos al calcular el encuadre del mapa", () => {
    expect(fieldBounds([], segments)).toEqual([
      [-0.69, -0.47],
      [-0.66, -0.44],
    ]);
  });
});
