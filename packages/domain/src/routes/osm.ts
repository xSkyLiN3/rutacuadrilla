import { z } from "zod";
import { DomainError } from "../errors.js";
import {
  type MultiLineStringGeometry,
  normalizeLineGeometry,
  normalizePointGeometry,
} from "./geometry.js";
import type { EditableRoutePoint, EditableStreetSegment, OsmCandidatePreview } from "./types.js";

export const osmAttribution = "© OpenStreetMap contributors · ODbL 1.0";

const tagsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional();
const osmElementSchema = z.object({
  center: z.object({ lat: z.number().finite(), lon: z.number().finite() }).optional(),
  geometry: z.array(z.object({ lat: z.number().finite(), lon: z.number().finite() })).optional(),
  id: z.union([z.number().int().nonnegative(), z.string().min(1)]),
  lat: z.number().finite().optional(),
  lon: z.number().finite().optional(),
  tags: tagsSchema,
  type: z.enum(["node", "way", "relation"]),
  version: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
});

const overpassSchema = z.object({
  elements: z.array(osmElementSchema).max(50_000),
});

function tag(
  tags: Record<string, string | number | boolean> | undefined,
  key: string,
): string | undefined {
  const value = tags?.[key];
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function representativeCoordinates(element: z.infer<typeof osmElementSchema>) {
  if (element.lat !== undefined && element.lon !== undefined) {
    return [element.lon, element.lat] as const;
  }
  if (element.center) return [element.center.lon, element.center.lat] as const;
  if (!element.geometry?.length) return null;
  const longitude =
    element.geometry.reduce((total, position) => total + position.lon, 0) / element.geometry.length;
  const latitude =
    element.geometry.reduce((total, position) => total + position.lat, 0) / element.geometry.length;
  return [longitude, latitude] as const;
}

export function previewOsmExport(raw: unknown): OsmCandidatePreview {
  const parsed = overpassSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError("OSM_EXPORT_INVALID", {
      details: parsed.error.issues,
      message: "La exportación Overpass/OSM pegada no es válida.",
      statusCode: 422,
    });
  }

  const points: EditableRoutePoint[] = [];
  const segments: EditableStreetSegment[] = [];
  const warnings: string[] = [];

  for (const element of parsed.data.elements) {
    const externalId = `${element.type}/${element.id}`;
    const sourceVersion = element.version === undefined ? undefined : String(element.version);
    if (element.type === "way" && tag(element.tags, "highway") && element.geometry?.length) {
      try {
        const name = tag(element.tags, "name");
        const geometry: MultiLineStringGeometry = normalizeLineGeometry({
          coordinates: element.geometry.map((position) => [position.lon, position.lat]),
          type: "LineString",
        });
        segments.push({
          attribution: osmAttribution,
          externalId,
          geometry,
          serviceSide: "BOTH",
          source: "OSM",
          ...(name ? { name } : {}),
          ...(sourceVersion ? { sourceVersion } : {}),
        });
      } catch {
        warnings.push(`Se omitió ${externalId}: geometría de calle inválida.`);
      }
      continue;
    }

    const number = tag(element.tags, "addr:housenumber");
    const coordinates = number ? representativeCoordinates(element) : null;
    if (number && coordinates) {
      const pointType = tag(element.tags, "entrance") ? "BUILDING_ENTRANCE" : "DWELLING";
      try {
        const street = tag(element.tags, "addr:street");
        const geometry = normalizePointGeometry({
          coordinates,
          type: "Point",
        });
        points.push({
          externalId,
          latitude: geometry.coordinates[1],
          longitude: geometry.coordinates[0],
          number,
          pointType,
          source: "OSM",
          ...(street ? { street } : {}),
        });
      } catch {
        warnings.push(`Se omitió ${externalId}: coordenadas de dirección inválidas.`);
      }
    }
  }

  return {
    attribution: osmAttribution,
    points,
    segments,
    summary: {
      candidatePoints: points.length,
      candidateSegments: segments.length,
      sourceElements: parsed.data.elements.length,
    },
    warnings,
  };
}
