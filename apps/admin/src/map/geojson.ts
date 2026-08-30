import type { PointType, ServiceSide } from "../api/types";
import { normalizeServiceSide } from "../lib/serviceSide";

export type Coordinate = readonly [longitude: number, latitude: number];

export interface MapPointInput {
  externalId: string;
  id: string;
  latitude: number;
  longitude: number;
  number?: string;
  pointType: PointType;
  street?: string;
}

export interface MapStreetInput {
  coordinates: Coordinate[];
  externalId: string;
  id: string;
  name: string;
  serviceSide?: ServiceSide;
  source: "GEOJSON" | "MANUAL" | "OSM";
}

export interface MapBoundaryInput {
  coordinates: Coordinate[][] | Coordinate[][][];
  type?: "MultiPolygon" | "Polygon";
}

interface PointFeature {
  geometry: { coordinates: Coordinate; type: "Point" };
  id: string;
  properties: {
    address: string;
    externalId: string;
    label: string;
    pointType: PointType;
    pointId: string;
  };
  type: "Feature";
}

interface StreetDirectionFeature {
  geometry: { coordinates: Coordinate; type: "Point" };
  id: string;
  properties: {
    externalId: string;
    marker: "END" | "START";
    name: string;
    streetId: string;
  };
  type: "Feature";
}

interface LineFeature {
  geometry: { coordinates: Coordinate[]; type: "LineString" };
  id: string;
  properties: Record<string, string>;
  type: "Feature";
}

interface PolygonFeature {
  geometry:
    | { coordinates: Coordinate[][]; type: "Polygon" }
    | { coordinates: Coordinate[][][]; type: "MultiPolygon" };
  id: string;
  properties: Record<string, string>;
  type: "Feature";
}

interface FeatureCollection<TFeature> {
  features: TFeature[];
  type: "FeatureCollection";
}

export interface RouteMapData {
  boundary: FeatureCollection<PolygonFeature>;
  bounds: [number, number, number, number] | null;
  hasOsmData: boolean;
  points: FeatureCollection<PointFeature>;
  routeLine: FeatureCollection<LineFeature>;
  streetDirections: FeatureCollection<StreetDirectionFeature>;
  streets: FeatureCollection<LineFeature>;
}

function pointAddress(point: MapPointInput): string {
  return `${point.street?.trim() || "Calle no informada"} ${point.number?.trim() || "S/N"}`;
}

function visitCoordinates(
  coordinates: Coordinate[],
  visit: (longitude: number, latitude: number) => void,
): void {
  for (const [longitude, latitude] of coordinates) visit(longitude, latitude);
}

export function buildRouteMapData(
  points: MapPointInput[],
  streets: MapStreetInput[] = [],
  boundary?: MapBoundaryInput,
): RouteMapData {
  let minLongitude = Number.POSITIVE_INFINITY;
  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  const includeInBounds = (longitude: number, latitude: number) => {
    minLongitude = Math.min(minLongitude, longitude);
    minLatitude = Math.min(minLatitude, latitude);
    maxLongitude = Math.max(maxLongitude, longitude);
    maxLatitude = Math.max(maxLatitude, latitude);
  };

  const pointFeatures = points.map<PointFeature>((point, index) => {
    includeInBounds(point.longitude, point.latitude);
    return {
      type: "Feature",
      id: point.id,
      geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
      properties: {
        address: pointAddress(point),
        externalId: point.externalId,
        label: String(index + 1),
        pointType: point.pointType,
        pointId: point.id,
      },
    };
  });

  const streetFeatures = streets.map<LineFeature>((street) => {
    visitCoordinates(street.coordinates, includeInBounds);
    return {
      type: "Feature",
      id: street.id,
      geometry: { type: "LineString", coordinates: street.coordinates },
      properties: {
        externalId: street.externalId,
        name: street.name,
        serviceSide: normalizeServiceSide(street.serviceSide),
        source: street.source,
      },
    };
  });
  const streetDirectionFeatures = streets.flatMap<StreetDirectionFeature>((street) => {
    const start = street.coordinates[0];
    const end = street.coordinates.at(-1);
    if (!start || !end) return [];
    return [
      {
        type: "Feature",
        id: `${street.id}:start`,
        geometry: { type: "Point", coordinates: start },
        properties: {
          externalId: street.externalId,
          marker: "START",
          name: street.name,
          streetId: street.id,
        },
      },
      {
        type: "Feature",
        id: `${street.id}:end`,
        geometry: { type: "Point", coordinates: end },
        properties: {
          externalId: street.externalId,
          marker: "END",
          name: street.name,
          streetId: street.id,
        },
      },
    ];
  });

  const boundaryFeatures: PolygonFeature[] = boundary
    ? [
        {
          type: "Feature",
          id: "route-boundary",
          geometry:
            boundary.type === "MultiPolygon"
              ? { type: "MultiPolygon", coordinates: boundary.coordinates as Coordinate[][][] }
              : { type: "Polygon", coordinates: boundary.coordinates as Coordinate[][] },
          properties: {},
        },
      ]
    : [];
  if (boundary?.type === "MultiPolygon") {
    for (const polygon of boundary.coordinates as Coordinate[][][]) {
      for (const ring of polygon) visitCoordinates(ring, includeInBounds);
    }
  } else {
    for (const ring of (boundary?.coordinates ?? []) as Coordinate[][]) {
      visitCoordinates(ring, includeInBounds);
    }
  }

  const routeCoordinates = points.map<Coordinate>((point) => [point.longitude, point.latitude]);
  const routeLineFeatures: LineFeature[] =
    routeCoordinates.length > 1
      ? [
          {
            type: "Feature",
            id: "route-line",
            geometry: { type: "LineString", coordinates: routeCoordinates },
            properties: {},
          },
        ]
      : [];

  return {
    points: { type: "FeatureCollection", features: pointFeatures },
    streets: { type: "FeatureCollection", features: streetFeatures },
    boundary: { type: "FeatureCollection", features: boundaryFeatures },
    routeLine: { type: "FeatureCollection", features: routeLineFeatures },
    streetDirections: { type: "FeatureCollection", features: streetDirectionFeatures },
    bounds: Number.isFinite(minLongitude)
      ? [minLongitude, minLatitude, maxLongitude, maxLatitude]
      : null,
    hasOsmData: streets.some((street) => street.source === "OSM"),
  };
}

export function supportsWebGl2(): boolean {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}
