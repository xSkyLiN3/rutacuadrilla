import type { FieldPoint, FieldSegment, PointState, ServiceSide } from "../types";

interface PointFeature {
  geometry: { coordinates: [number, number]; type: "Point" };
  id: number;
  properties: { address: string; label: string; pointId: string; state: PointState };
  type: "Feature";
}

export interface FieldPointCollection {
  features: PointFeature[];
  type: "FeatureCollection";
}

interface SegmentFeature {
  geometry: FieldSegment["geometry"];
  id: number;
  properties: {
    displayOrder: number;
    externalId: string;
    name: string;
    segmentId: string;
    serviceSide: ServiceSide;
  };
  type: "Feature";
}

export interface FieldSegmentCollection {
  features: SegmentFeature[];
  type: "FeatureCollection";
}

export function buildFieldPointCollection(points: FieldPoint[]): FieldPointCollection {
  return {
    type: "FeatureCollection",
    features: points.map((point) => ({
      type: "Feature",
      id: point.displayOrder,
      geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
      properties: {
        address: `${point.street?.trim() || "Calle no informada"} ${point.number?.trim() || "S/N"}`,
        label: String(point.displayOrder + 1),
        pointId: point.id,
        state: point.state,
      },
    })),
  };
}

export function findNearestFieldPointId(
  points: Array<Pick<FieldPoint, "id" | "latitude" | "longitude">>,
  project: (coordinates: [number, number]) => { x: number; y: number },
  target: { x: number; y: number },
  maximumDistance = 26,
): string | undefined {
  let nearestId: string | undefined;
  let nearestDistanceSquared = maximumDistance * maximumDistance;
  for (const point of points) {
    const pixel = project([point.longitude, point.latitude]);
    const distanceSquared = (pixel.x - target.x) ** 2 + (pixel.y - target.y) ** 2;
    if (distanceSquared <= nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared;
      nearestId = point.id;
    }
  }
  return nearestId;
}

export function buildFieldSegmentCollection(segments: FieldSegment[]): FieldSegmentCollection {
  return {
    type: "FeatureCollection",
    features: segments.map((segment) => ({
      type: "Feature",
      id: segment.displayOrder,
      geometry: segment.geometry,
      properties: {
        displayOrder: segment.displayOrder,
        externalId: segment.externalId,
        name: segment.name?.trim() || "Tramo sin nombre",
        segmentId: segment.id,
        serviceSide: segment.serviceSide,
      },
    })),
  };
}

export function fieldBounds(
  points: FieldPoint[],
  segments: FieldSegment[] = [],
): [[number, number], [number, number]] | null {
  const segmentCoordinates = segments.flatMap((segment) => segment.geometry.coordinates.flat());
  if (points.length === 0 && segmentCoordinates.length === 0) return null;
  const longitudes = [
    ...points.map((point) => point.longitude),
    ...segmentCoordinates.map((coordinate) => coordinate[0]),
  ];
  const latitudes = [
    ...points.map((point) => point.latitude),
    ...segmentCoordinates.map((coordinate) => coordinate[1]),
  ];
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  if (west === east && south === north) {
    return [
      [west - 0.001, south - 0.001],
      [east + 0.001, north + 0.001],
    ];
  }
  return [
    [west, south],
    [east, north],
  ];
}
