import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../errors.js";

export type Position = [longitude: number, latitude: number];

export type PointGeometry = {
  coordinates: Position;
  type: "Point";
};

export type MultiLineStringGeometry = {
  coordinates: Position[][];
  type: "MultiLineString";
};

export type MultiPolygonGeometry = {
  coordinates: Position[][][];
  type: "MultiPolygon";
};

export type RouteGeometry = MultiLineStringGeometry | MultiPolygonGeometry | PointGeometry;
export type BoundingBox = [west: number, south: number, east: number, north: number];

const coordinate = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const lineString = z.array(coordinate).min(2).max(50_000);
const linearRing = z.array(coordinate).min(4).max(50_000);
const polygonCoordinates = z.array(linearRing).min(1).max(2_000);
const multiPolygonCoordinates = z.array(polygonCoordinates).min(1).max(2_000);

const pointGeometrySchema = z.object({
  coordinates: coordinate,
  type: z.literal("Point"),
});

const lineGeometrySchema = z.union([
  z.object({ coordinates: lineString, type: z.literal("LineString") }),
  z.object({
    coordinates: z.array(lineString).min(1).max(20_000),
    type: z.literal("MultiLineString"),
  }),
]);

const areaGeometrySchema = z.union([
  z.object({ coordinates: polygonCoordinates, type: z.literal("Polygon") }),
  z.object({ coordinates: multiPolygonCoordinates, type: z.literal("MultiPolygon") }),
]);

function roundCoordinate(value: number): number {
  return Number(value.toFixed(7));
}

function normalizePosition(position: readonly [number, number]): Position {
  return [roundCoordinate(position[0]), roundCoordinate(position[1])];
}

function samePosition(left: Position, right: Position): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function geometryError(message: string, cause?: unknown): DomainError {
  return new DomainError("INVALID_GEOMETRY", { cause, message, statusCode: 422 });
}

export function normalizePointGeometry(raw: unknown): PointGeometry {
  const parsed = pointGeometrySchema.safeParse(raw);
  if (!parsed.success) throw geometryError("La geometría de punto no es válida.", parsed.error);
  return { coordinates: normalizePosition(parsed.data.coordinates), type: "Point" };
}

export function normalizeLineGeometry(raw: unknown): MultiLineStringGeometry {
  const parsed = lineGeometrySchema.safeParse(raw);
  if (!parsed.success) throw geometryError("La geometría de calle no es válida.", parsed.error);
  const lines =
    parsed.data.type === "LineString" ? [parsed.data.coordinates] : parsed.data.coordinates;
  return {
    coordinates: lines.map((line) => line.map(normalizePosition)),
    type: "MultiLineString",
  };
}

export function normalizeAreaGeometry(raw: unknown): MultiPolygonGeometry {
  const parsed = areaGeometrySchema.safeParse(raw);
  if (!parsed.success) throw geometryError("El área de la ruta no es válida.", parsed.error);
  const polygons =
    parsed.data.type === "Polygon" ? [parsed.data.coordinates] : parsed.data.coordinates;
  const normalized = polygons.map((polygon) =>
    polygon.map((ring) => {
      const positions = ring.map(normalizePosition);
      if (!samePosition(positions[0] as Position, positions.at(-1) as Position)) {
        throw geometryError("Cada anillo del área debe estar cerrado.");
      }
      return positions;
    }),
  );
  return { coordinates: normalized, type: "MultiPolygon" };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function positionsOfGeometry(geometry: RouteGeometry): Position[] {
  if (geometry.type === "Point") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates.flat();
  return geometry.coordinates.flat(2);
}

export function geometryBounds(
  geometries: readonly (RouteGeometry | null | undefined)[],
): BoundingBox | null {
  const positions = geometries.flatMap((geometry) =>
    geometry ? positionsOfGeometry(geometry) : [],
  );
  if (positions.length === 0) return null;
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const [longitude, latitude] of positions) {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }
  return [west, south, east, north];
}

export function parseStoredGeometry<T extends RouteGeometry>(value: unknown): T {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return parsed as T;
}
