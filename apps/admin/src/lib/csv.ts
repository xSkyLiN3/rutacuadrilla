import type { PointSource, PointType, RoutePoint } from "../api/types";

export const CANONICAL_CSV_COLUMNS = [
  "external_id",
  "street",
  "number",
  "latitude",
  "longitude",
  "point_type",
  "source",
] as const;

export const POINT_TYPES: readonly PointType[] = [
  "DWELLING",
  "BUILDING_ENTRANCE",
  "COMPLEX_ACCESS",
  "SPECIAL",
];

export const POINT_SOURCES: readonly PointSource[] = ["MANUAL", "CSV", "OSM", "GEOJSON"];

export interface CsvRowPreview {
  rowNumber: number;
  externalId: string;
  street: string;
  number: string;
  latitude: number | null;
  longitude: number | null;
  pointType: string;
  source: string;
  errors: string[];
  valid: boolean;
}

export interface CsvPreview {
  rows: CsvRowPreview[];
  globalErrors: string[];
  validRows: CsvRowPreview[];
  errorCount: number;
}

interface ParsedLine {
  values: string[];
  error?: string;
}

function parseCsvLine(line: string): ParsedLine {
  const values: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return quoted ? { values, error: "Comillas sin cerrar." } : { values };
}

function toCoordinate(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedHeader(values: string[]): string[] {
  return values.map((value) => value.trim().toLocaleLowerCase("en"));
}

function isPointType(value: string): value is PointType {
  return POINT_TYPES.includes(value as PointType);
}

function isPointSource(value: string): value is PointSource {
  return POINT_SOURCES.includes(value as PointSource);
}

export function parseRouteCsv(csv: string): CsvPreview {
  const normalized = csv.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  if (lines.every((line) => line.trim() === "")) {
    return {
      rows: [],
      validRows: [],
      globalErrors: ["Pega o carga un CSV para comenzar."],
      errorCount: 0,
    };
  }

  const headerLineIndex = lines.findIndex((line) => line.trim() !== "");
  const headerResult = parseCsvLine(lines[headerLineIndex] ?? "");
  const headers = normalizedHeader(headerResult.values);
  const expectedHeader = CANONICAL_CSV_COLUMNS.join(",");
  const headerMatches =
    headers.length === CANONICAL_CSV_COLUMNS.length &&
    CANONICAL_CSV_COLUMNS.every((column, index) => headers[index] === column);
  const globalErrors: string[] = [];

  if (headerResult.error) {
    globalErrors.push(`Encabezado: ${headerResult.error}`);
  }
  if (!headerMatches) {
    globalErrors.push(`Cabecera esperada: ${expectedHeader}.`);
  }

  const rows: CsvRowPreview[] = [];
  const seenExternalIds = new Map<string, number>();
  const seenSignatures = new Map<string, number>();

  lines.slice(headerLineIndex + 1).forEach((line, relativeIndex) => {
    if (line.trim() === "") {
      return;
    }

    const rowNumber = headerLineIndex + relativeIndex + 2;
    const parsed = parseCsvLine(line);
    const [
      externalId = "",
      street = "",
      number = "",
      rawLatitude = "",
      rawLongitude = "",
      rawPointType = "",
      rawSource = "",
    ] = parsed.values;
    const latitude = toCoordinate(rawLatitude);
    const longitude = toCoordinate(rawLongitude);
    const pointType = rawPointType.trim().toLocaleUpperCase("en");
    const source = rawSource.trim().toLocaleUpperCase("en");
    const errors: string[] = [];

    if (parsed.error) {
      errors.push(parsed.error);
    }
    if (parsed.values.length !== CANONICAL_CSV_COLUMNS.length) {
      errors.push(
        `Se esperaban ${CANONICAL_CSV_COLUMNS.length} columnas y se recibieron ${parsed.values.length}.`,
      );
    } else {
      if (!externalId) {
        errors.push("El identificador externo es obligatorio.");
      } else if (externalId.length > 128) {
        errors.push("El identificador externo no puede superar 128 caracteres.");
      }
      if (street.length > 200) {
        errors.push("La calle no puede superar 200 caracteres.");
      }
      if (number.length > 50) {
        errors.push("El número no puede superar 50 caracteres.");
      }
      if (latitude === null) {
        errors.push("Latitud inválida.");
      } else if (latitude < -90 || latitude > 90) {
        errors.push("La latitud debe estar entre -90 y 90.");
      }
      if (longitude === null) {
        errors.push("Longitud inválida.");
      } else if (longitude < -180 || longitude > 180) {
        errors.push("La longitud debe estar entre -180 y 180.");
      }
      if (!isPointType(pointType)) {
        errors.push(`Tipo de punto inválido. Usa ${POINT_TYPES.join(", ")}.`);
      }
      if (!isPointSource(source)) {
        errors.push(`Fuente inválida. Usa ${POINT_SOURCES.join(", ")}.`);
      }
    }

    if (errors.length === 0 && latitude !== null && longitude !== null) {
      const externalKey = `${source}:${externalId.toLocaleLowerCase("en")}`;
      const previousExternalRow = seenExternalIds.get(externalKey);
      if (previousExternalRow !== undefined) {
        errors.push(
          `Identificador externo duplicado para la misma fuente; ya aparece en la fila ${previousExternalRow}.`,
        );
      }

      const signature = [
        latitude.toFixed(7),
        longitude.toFixed(7),
        street.toLocaleLowerCase("es"),
        number.toLocaleLowerCase("es"),
      ].join("|");
      const previousSignatureRow = seenSignatures.get(signature);
      if (previousSignatureRow !== undefined) {
        errors.push(`Misma ubicación y dirección que la fila ${previousSignatureRow}.`);
      }

      if (errors.length === 0) {
        seenExternalIds.set(externalKey, rowNumber);
        seenSignatures.set(signature, rowNumber);
      }
    }

    rows.push({
      rowNumber,
      externalId,
      street,
      number,
      latitude,
      longitude,
      pointType,
      source,
      errors,
      valid: errors.length === 0,
    });
  });

  if (rows.length === 0) {
    globalErrors.push("El archivo no contiene filas de puntos.");
  }

  const validRows = rows.filter((row) => row.valid);
  return {
    rows,
    validRows,
    globalErrors,
    errorCount: rows.reduce((total, row) => total + row.errors.length, 0),
  };
}

function serializeCsvCell(value: string | number | undefined): string {
  const normalized = String(value ?? "").replace(/\r?\n/g, " ");
  return /[",]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
}

export function serializeRoutePointsCsv(points: readonly RoutePoint[]): string {
  const rows = points.map((point) =>
    [
      point.externalId,
      point.street,
      point.number,
      point.latitude,
      point.longitude,
      point.pointType,
      point.source,
    ]
      .map(serializeCsvCell)
      .join(","),
  );
  return [CANONICAL_CSV_COLUMNS.join(","), ...rows].join("\n");
}
