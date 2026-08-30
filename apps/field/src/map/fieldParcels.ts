import type { FieldPoint } from "../types";

type Position = [number, number];
type LinearRing = Position[];
type PolygonCoordinates = LinearRing[];

export type FieldParcelGeometry =
  | { coordinates: PolygonCoordinates; type: "Polygon" }
  | { coordinates: PolygonCoordinates[]; type: "MultiPolygon" };

export interface FieldParcelCatalogFeature {
  geometry: FieldParcelGeometry;
  properties: { externalId: string };
  type: "Feature";
}

export interface FieldParcelCatalog {
  features: FieldParcelCatalogFeature[];
  type: "FeatureCollection";
}

interface FieldParcelFeature extends FieldParcelCatalogFeature {
  id: number;
  properties: {
    externalId: string;
    pointId: string;
    selected: boolean;
  };
}

export interface FieldParcelCollection {
  features: FieldParcelFeature[];
  type: "FeatureCollection";
}

export const EMPTY_FIELD_PARCEL_CATALOG: FieldParcelCatalog = {
  features: [],
  type: "FeatureCollection",
};

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

function isLinearRing(value: unknown): value is LinearRing {
  return Array.isArray(value) && value.length >= 4 && value.every(isPosition);
}

function isPolygonCoordinates(value: unknown): value is PolygonCoordinates {
  return Array.isArray(value) && value.length > 0 && value.every(isLinearRing);
}

function isParcelGeometry(value: unknown): value is FieldParcelGeometry {
  if (!value || typeof value !== "object") return false;
  const geometry = value as { coordinates?: unknown; type?: unknown };
  if (geometry.type === "Polygon") return isPolygonCoordinates(geometry.coordinates);
  return (
    geometry.type === "MultiPolygon" &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length > 0 &&
    geometry.coordinates.every(isPolygonCoordinates)
  );
}

export function parseFieldParcelCatalog(value: unknown): FieldParcelCatalog {
  if (!value || typeof value !== "object") {
    throw new Error("El archivo de predios no contiene un objeto GeoJSON.");
  }
  const collection = value as { features?: unknown; type?: unknown };
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("El archivo de predios no contiene una FeatureCollection.");
  }

  const externalIds = new Set<string>();
  const features = collection.features.map((candidate, index): FieldParcelCatalogFeature => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`El predio ${index + 1} no es una Feature válida.`);
    }
    const feature = candidate as {
      geometry?: unknown;
      properties?: { externalId?: unknown };
      type?: unknown;
    };
    const externalId = feature.properties?.externalId;
    if (
      feature.type !== "Feature" ||
      typeof externalId !== "string" ||
      !externalId.trim() ||
      !isParcelGeometry(feature.geometry)
    ) {
      throw new Error(`El predio ${index + 1} no tiene identificador o polígono válido.`);
    }
    if (externalIds.has(externalId)) {
      throw new Error(`El archivo de predios repite ${externalId}.`);
    }
    externalIds.add(externalId);
    return {
      type: "Feature",
      properties: { externalId },
      geometry: feature.geometry,
    };
  });

  return { type: "FeatureCollection", features };
}

export function buildFieldParcelCollection(
  catalog: FieldParcelCatalog,
  points: FieldPoint[],
  selectedPointId?: string,
): FieldParcelCollection {
  const pointsByExternalId = new Map(points.map((point) => [point.externalId, point]));
  return {
    type: "FeatureCollection",
    features: catalog.features.flatMap((feature) => {
      const point = pointsByExternalId.get(feature.properties.externalId);
      if (!point) return [];
      return [
        {
          ...feature,
          id: point.displayOrder,
          properties: {
            externalId: feature.properties.externalId,
            pointId: point.id,
            selected: point.id === selectedPointId,
          },
        },
      ];
    }),
  };
}
