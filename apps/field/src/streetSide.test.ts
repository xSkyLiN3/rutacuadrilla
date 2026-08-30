import { describe, expect, it } from "vitest";
import {
  formatFieldSegmentSide,
  normalizeFieldSegments,
  physicalServiceSideLabel,
  SERVICE_SIDE_LABELS,
} from "./streetSide";

function segment(serviceSide: "BOTH" | "LEFT" | "RIGHT") {
  const displayOrder = { LEFT: 0, BOTH: 1, RIGHT: 2 }[serviceSide];
  return {
    id: `segment-${serviceSide}`,
    externalId: `external-${serviceSide}`,
    displayOrder,
    streetSegmentVersionId: `version-${serviceSide}`,
    name: "Los Aromos",
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
    serviceSide,
  };
}

describe("normalizeFieldSegments", () => {
  it("conserva el lado explícito y el orden de coordenadas del tramo", () => {
    const result = normalizeFieldSegments([segment("RIGHT"), segment("LEFT"), segment("BOTH")]);

    expect(result.map(({ serviceSide }) => serviceSide)).toEqual(["LEFT", "BOTH", "RIGHT"]);
    expect(result[0]?.geometry.coordinates[0]).toEqual([
      [-0.67, -0.45],
      [-0.66, -0.44],
    ]);
    expect(SERVICE_SIDE_LABELS).toEqual({
      LEFT: "Lado izquierdo",
      RIGHT: "Lado derecho",
      BOTH: "Ambos lados",
    });
  });

  it("rechaza un paquete heredado sin tramos en vez de inventar asignaciones", () => {
    expect(() => normalizeFieldSegments(undefined)).toThrow("INVALID_FIELD_SEGMENTS");
  });

  it("rechaza un lado desconocido en vez de inferirlo", () => {
    expect(() => normalizeFieldSegments([{ ...segment("LEFT"), serviceSide: "NEAREST" }])).toThrow(
      "INVALID_FIELD_SERVICE_SIDE",
    );
  });

  it("rechaza componentes desconectados cuando el lado depende de su sentido", () => {
    const disconnected = {
      ...segment("RIGHT"),
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-0.67, -0.45],
            [-0.66, -0.44],
          ],
          [
            [-0.65, -0.43],
            [-0.64, -0.42],
          ],
        ],
      },
    };

    expect(() => normalizeFieldSegments([disconnected])).toThrow(
      "INCOHERENT_FIELD_SEGMENT_DIRECTION",
    );
  });

  it("traduce el lado relativo a una orientación física comprensible", () => {
    const syntheticEastToWest = {
      ...segment("RIGHT"),
      geometry: {
        type: "MultiLineString" as const,
        coordinates: [[[0.0024, 0.001] as [number, number], [0.0012, 0.00103] as [number, number]]],
      },
    };

    expect(physicalServiceSideLabel(syntheticEastToWest)).toBe("Lado norte");
    expect(formatFieldSegmentSide(syntheticEastToWest)).toBe(
      "Lado norte · lado derecho del trazado",
    );
  });
});
