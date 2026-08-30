import type { FieldSegment, ServiceSide } from "./types";

export const SERVICE_SIDE_LABELS: Record<ServiceSide, string> = {
  LEFT: "Lado izquierdo",
  RIGHT: "Lado derecho",
  BOTH: "Ambos lados",
};

export function physicalServiceSideLabel(
  segment: Pick<FieldSegment, "geometry" | "serviceSide">,
): string {
  if (segment.serviceSide === "BOTH") return SERVICE_SIDE_LABELS.BOTH;
  const first = segment.geometry.coordinates[0]?.[0];
  const lastLine = segment.geometry.coordinates.at(-1);
  const last = lastLine?.at(-1);
  if (!first || !last) return SERVICE_SIDE_LABELS[segment.serviceSide];

  const averageLatitude = (first[1] + last[1]) / 2;
  const east = (last[0] - first[0]) * Math.cos((averageLatitude * Math.PI) / 180);
  const north = last[1] - first[1];
  const sideEast = segment.serviceSide === "LEFT" ? -north : north;
  const sideNorth = segment.serviceSide === "LEFT" ? east : -east;
  if (Math.abs(sideNorth) >= Math.abs(sideEast)) {
    return sideNorth >= 0 ? "Lado norte" : "Lado sur";
  }
  return sideEast >= 0 ? "Lado este" : "Lado oeste";
}

export function formatFieldSegmentSide(
  segment: Pick<FieldSegment, "geometry" | "serviceSide">,
): string {
  const physical = physicalServiceSideLabel(segment);
  if (segment.serviceSide === "BOTH") return physical;
  return `${physical} · ${SERVICE_SIDE_LABELS[segment.serviceSide].toLocaleLowerCase("es")} del trazado`;
}

const SERVICE_SIDES = new Set<ServiceSide>(["LEFT", "RIGHT", "BOTH"]);

export function isServiceSide(value: unknown): value is ServiceSide {
  return typeof value === "string" && SERVICE_SIDES.has(value as ServiceSide);
}

function isCoordinate(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1]) &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function normalizeGeometry(value: unknown): FieldSegment["geometry"] {
  if (!value || typeof value !== "object") throw new Error("INVALID_FIELD_SEGMENT_GEOMETRY");
  const geometry = value as { coordinates?: unknown; type?: unknown };
  if (
    geometry.type !== "MultiLineString" ||
    !Array.isArray(geometry.coordinates) ||
    geometry.coordinates.length === 0 ||
    geometry.coordinates.some(
      (line) =>
        !Array.isArray(line) ||
        line.length < 2 ||
        line.some((coordinate) => !isCoordinate(coordinate)),
    )
  ) {
    throw new Error("INVALID_FIELD_SEGMENT_GEOMETRY");
  }
  return {
    type: "MultiLineString",
    coordinates: geometry.coordinates.map((line) =>
      (line as Array<[number, number]>).map((coordinate) => [coordinate[0], coordinate[1]]),
    ),
  };
}

function nonEmptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(code);
  return value;
}

function isSegmentSource(value: unknown): value is FieldSegment["source"] {
  return value === "GEOJSON" || value === "MANUAL" || value === "OSM";
}

function hasCoherentDirection(geometry: FieldSegment["geometry"]): boolean {
  return geometry.coordinates.every((line, index, lines) => {
    if (index === 0) return true;
    const previousEnd = lines[index - 1]?.at(-1);
    const currentStart = line[0];
    return previousEnd?.[0] === currentStart?.[0] && previousEnd?.[1] === currentStart?.[1];
  });
}

/**
 * Normaliza exclusivamente la asignación declarada por el paquete. No intenta
 * relacionar puntos con tramos ni deducir un lado mediante proximidad.
 */
export function normalizeFieldSegments(value: unknown): FieldSegment[] {
  if (!Array.isArray(value)) throw new Error("INVALID_FIELD_SEGMENTS");

  const identifiers = new Set<string>();
  const normalized = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("INVALID_FIELD_SEGMENT");
    const raw = candidate as Record<string, unknown>;
    const id = nonEmptyString(raw.id, "INVALID_FIELD_SEGMENT_ID");
    if (identifiers.has(id)) throw new Error("DUPLICATE_FIELD_SEGMENT");
    identifiers.add(id);
    if (!Number.isInteger(raw.displayOrder) || Number(raw.displayOrder) < 0) {
      throw new Error("INVALID_FIELD_SEGMENT_ORDER");
    }
    if (!isServiceSide(raw.serviceSide)) throw new Error("INVALID_FIELD_SERVICE_SIDE");
    if (!isSegmentSource(raw.source)) throw new Error("INVALID_FIELD_SEGMENT_SOURCE");
    const geometry = normalizeGeometry(raw.geometry);
    if (raw.serviceSide !== "BOTH" && !hasCoherentDirection(geometry)) {
      throw new Error("INCOHERENT_FIELD_SEGMENT_DIRECTION");
    }

    return {
      id,
      externalId: nonEmptyString(raw.externalId, "INVALID_FIELD_SEGMENT_EXTERNAL_ID"),
      displayOrder: Number(raw.displayOrder),
      streetSegmentVersionId: nonEmptyString(
        raw.streetSegmentVersionId,
        "INVALID_FIELD_SEGMENT_VERSION_ID",
      ),
      serviceSide: raw.serviceSide,
      source: raw.source,
      geometry,
      ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name } : {}),
      ...(typeof raw.sourceVersion === "string" && raw.sourceVersion
        ? { sourceVersion: raw.sourceVersion }
        : {}),
      ...(typeof raw.attribution === "string" && raw.attribution
        ? { attribution: raw.attribution }
        : {}),
    } satisfies FieldSegment;
  });

  return normalized.sort(
    (left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id),
  );
}
