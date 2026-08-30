import type { MultiPolygonGeometry, PolygonGeometry, Position } from "../api/types";

function pointInRing([longitude, latitude]: Position, ring: Position[]): boolean {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const [currentLongitude, currentLatitude] = ring[current] ?? [0, 0];
    const [previousLongitude, previousLatitude] = ring[previous] ?? [0, 0];
    const crosses =
      currentLatitude > latitude !== previousLatitude > latitude &&
      longitude <
        ((previousLongitude - currentLongitude) * (latitude - currentLatitude)) /
          (previousLatitude - currentLatitude) +
          currentLongitude;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: Position, rings: Position[][]): boolean {
  const outer = rings[0];
  if (!outer || !pointInRing(point, outer)) return false;
  return !rings.slice(1).some((hole) => pointInRing(point, hole));
}

export function pointInArea(
  point: Position,
  area: PolygonGeometry | MultiPolygonGeometry | null,
): boolean | null {
  if (!area) return null;
  const polygons = area.type === "Polygon" ? [area.coordinates] : area.coordinates;
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}

export function parseAreaGeometry(value: string): PolygonGeometry | MultiPolygonGeometry | null {
  if (!value.trim()) return null;
  const parsed = JSON.parse(value) as { coordinates?: unknown; type?: unknown };
  if (
    (parsed.type !== "Polygon" && parsed.type !== "MultiPolygon") ||
    !Array.isArray(parsed.coordinates)
  ) {
    throw new TypeError("El área debe ser una geometría GeoJSON Polygon o MultiPolygon.");
  }
  return parsed as PolygonGeometry | MultiPolygonGeometry;
}
