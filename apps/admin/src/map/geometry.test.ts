import { describe, expect, it } from "vitest";
import type { PolygonGeometry } from "../api/types";
import { parseAreaGeometry, pointInArea } from "./geometry";

const area: PolygonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-0.7, -0.5],
      [-0.6, -0.5],
      [-0.6, -0.4],
      [-0.7, -0.4],
      [-0.7, -0.5],
    ],
  ],
};

describe("geometry utilities", () => {
  it("advierte puntos fuera del área sin bloquear cuando no hay área", () => {
    expect(pointInArea([-0.65, -0.45], area)).toBe(true);
    expect(pointInArea([-71, -0.45], area)).toBe(false);
    expect(pointInArea([-71, -0.45], null)).toBeNull();
  });

  it("solo acepta Polygon o MultiPolygon al preparar el área", () => {
    expect(parseAreaGeometry(JSON.stringify(area))).toEqual(area);
    expect(parseAreaGeometry("  ")).toBeNull();
    expect(() => parseAreaGeometry('{"type":"Point","coordinates":[0,0]}')).toThrow();
  });
});
