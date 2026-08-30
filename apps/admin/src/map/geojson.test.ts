import { describe, expect, it } from "vitest";
import { buildRouteMapData } from "./geojson";

describe("buildRouteMapData", () => {
  it("conserva orden, geometrías y atribución OSM sin depender de una red", () => {
    const result = buildRouteMapData(
      [
        {
          id: "point-1",
          externalId: "home-1",
          street: "Los Aromos",
          number: "12",
          latitude: -0.45,
          longitude: -0.66,
          pointType: "DWELLING",
        },
        {
          id: "point-2",
          externalId: "home-2",
          latitude: -0.46,
          longitude: -0.65,
          pointType: "SPECIAL",
        },
      ],
      [
        {
          id: "street-1",
          externalId: "way/10",
          name: "Los Aromos",
          serviceSide: "LEFT",
          source: "OSM",
          coordinates: [
            [-0.67, -0.44],
            [-0.64, -0.47],
          ],
        },
      ],
      {
        coordinates: [
          [
            [-0.68, -0.43],
            [-0.63, -0.43],
            [-0.63, -0.48],
            [-0.68, -0.43],
          ],
        ],
      },
    );

    expect(result.points.features.map((feature) => feature.properties.label)).toEqual(["1", "2"]);
    expect(result.routeLine.features[0]?.geometry.coordinates).toEqual([
      [-0.66, -0.45],
      [-0.65, -0.46],
    ]);
    expect(result.hasOsmData).toBe(true);
    expect(result.streets.features[0]?.properties.serviceSide).toBe("LEFT");
    expect(
      result.streetDirections.features.map((feature) => ({
        coordinates: feature.geometry.coordinates,
        marker: feature.properties.marker,
        streetId: feature.properties.streetId,
      })),
    ).toEqual([
      { coordinates: [-0.67, -0.44], marker: "START", streetId: "street-1" },
      { coordinates: [-0.64, -0.47], marker: "END", streetId: "street-1" },
    ]);
    expect(result.bounds).toEqual([-0.68, -0.48, -0.63, -0.43]);
  });

  it("interpreta los segmentos antiguos sin lado explícito como atención de ambos lados", () => {
    const result = buildRouteMapData(
      [],
      [
        {
          id: "street-legacy",
          externalId: "legacy/1",
          name: "Calle histórica",
          source: "MANUAL",
          coordinates: [
            [-0.67, -0.44],
            [-0.66, -0.45],
          ],
        },
      ],
    );

    expect(result.streets.features[0]?.properties.serviceSide).toBe("BOTH");
  });

  it("prepara 10.000 puntos para clustering sin truncarlos", () => {
    const points = Array.from({ length: 10_000 }, (_, index) => ({
      id: `point-${index}`,
      externalId: `external-${index}`,
      latitude: -0.5 + (index % 100) / 10_000,
      longitude: -0.7 + Math.floor(index / 100) / 10_000,
      pointType: "DWELLING" as const,
    }));

    const result = buildRouteMapData(points);

    expect(result.points.features).toHaveLength(10_000);
    expect(result.routeLine.features[0]?.geometry.coordinates).toHaveLength(10_000);
  });
});
