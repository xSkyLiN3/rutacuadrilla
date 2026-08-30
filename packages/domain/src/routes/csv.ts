import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { pointSources, pointTypes, type PointSource, type PointType } from "../constants.js";

export const canonicalCsvColumns = [
  "external_id",
  "street",
  "number",
  "latitude",
  "longitude",
  "point_type",
  "source",
] as const;

export type CanonicalCsvColumn = (typeof canonicalCsvColumns)[number];

export type CanonicalRoutePoint = {
  externalId: string;
  latitude: number;
  longitude: number;
  number?: string;
  pointType: PointType;
  source: PointSource;
  street?: string;
};

export type CsvRowError = {
  code: string;
  field?: CanonicalCsvColumn | "header" | "row";
  message: string;
  row: number;
  value?: string;
};

export type CsvPreview = {
  errors: CsvRowError[];
  rows: CanonicalRoutePoint[];
  summary: {
    duplicateRows: number;
    invalidRows: number;
    totalRows: number;
    validRows: number;
  };
  valid: boolean;
};

const optionalStreet = z
  .string()
  .trim()
  .max(200)
  .transform((value) => (value.length > 0 ? value : undefined));

const optionalNumber = z
  .string()
  .trim()
  .max(50)
  .transform((value) => (value.length > 0 ? value : undefined));

function coordinate(minimum: number, maximum: number) {
  return z
    .string()
    .trim()
    .min(1)
    .transform((value) => Number(value))
    .pipe(z.number().finite().min(minimum).max(maximum));
}

const csvPointSchema = z.object({
  external_id: z.string().trim().min(1).max(128),
  latitude: coordinate(-90, 90),
  longitude: coordinate(-180, 180),
  number: optionalNumber,
  point_type: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(pointTypes)),
  source: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(pointSources)),
  street: optionalStreet,
});

function issueCode(field: string): string {
  switch (field) {
    case "external_id":
      return "INVALID_EXTERNAL_ID";
    case "latitude":
      return "INVALID_LATITUDE";
    case "longitude":
      return "INVALID_LONGITUDE";
    case "point_type":
      return "INVALID_POINT_TYPE";
    case "source":
      return "INVALID_SOURCE";
    case "street":
      return "INVALID_STREET";
    case "number":
      return "INVALID_NUMBER";
    default:
      return "INVALID_ROW";
  }
}

function emptyPreview(error: CsvRowError): CsvPreview {
  return {
    errors: [error],
    rows: [],
    summary: {
      duplicateRows: 0,
      invalidRows: error.row > 1 ? 1 : 0,
      totalRows: 0,
      validRows: 0,
    },
    valid: false,
  };
}

export function previewRouteCsv(csv: string): CsvPreview {
  if (csv.trim().length === 0) {
    return emptyPreview({
      code: "CSV_EMPTY",
      field: "row",
      message: "El CSV está vacío.",
      row: 1,
    });
  }

  let matrix: string[][];
  try {
    matrix = parse(csv, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as string[][];
  } catch (error) {
    return emptyPreview({
      code: "CSV_PARSE_ERROR",
      field: "row",
      message: error instanceof Error ? error.message : "No se pudo leer el CSV.",
      row: 1,
    });
  }

  const header = matrix[0] ?? [];
  const normalizedHeader = header.map((value) => value.trim().toLowerCase());
  const headerMatches =
    normalizedHeader.length === canonicalCsvColumns.length &&
    canonicalCsvColumns.every((column, index) => normalizedHeader[index] === column);
  if (!headerMatches) {
    return emptyPreview({
      code: "CSV_HEADER_INVALID",
      field: "header",
      message: `Cabecera esperada: ${canonicalCsvColumns.join(",")}`,
      row: 1,
      value: header.join(","),
    });
  }

  const dataRows = matrix.slice(1);
  if (dataRows.length === 0) {
    return emptyPreview({
      code: "CSV_NO_DATA",
      field: "row",
      message: "El CSV no contiene filas de puntos.",
      row: 2,
    });
  }

  const errors: CsvRowError[] = [];
  const rows: CanonicalRoutePoint[] = [];
  const externalKeys = new Map<string, number>();
  const signatures = new Map<string, number>();
  let duplicateRows = 0;

  dataRows.forEach((values, dataIndex) => {
    const rowNumber = dataIndex + 2;
    const rowErrorsBefore = errors.length;
    if (values.length !== canonicalCsvColumns.length) {
      errors.push({
        code: "CSV_COLUMN_COUNT",
        field: "row",
        message: `Se esperaban ${canonicalCsvColumns.length} columnas y se recibieron ${values.length}.`,
        row: rowNumber,
      });
      return;
    }

    const record = Object.fromEntries(
      canonicalCsvColumns.map((column, index) => [column, values[index] ?? ""]),
    );
    const parsed = csvPointSchema.safeParse(record);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "row");
        const value =
          field in record ? String(record[field as keyof typeof record] ?? "") : undefined;
        errors.push({
          code: issueCode(field),
          field: canonicalCsvColumns.includes(field as CanonicalCsvColumn)
            ? (field as CanonicalCsvColumn)
            : "row",
          message: issue.message,
          row: rowNumber,
          ...(value !== undefined ? { value } : {}),
        });
      }
      return;
    }

    const point: CanonicalRoutePoint = {
      externalId: parsed.data.external_id,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      pointType: parsed.data.point_type,
      source: parsed.data.source,
      ...(parsed.data.number ? { number: parsed.data.number } : {}),
      ...(parsed.data.street ? { street: parsed.data.street } : {}),
    };
    const externalKey = `${point.source}:${point.externalId.toLocaleLowerCase("en")}`;
    const signature = [
      point.latitude.toFixed(7),
      point.longitude.toFixed(7),
      point.street?.toLocaleLowerCase("es") ?? "",
      point.number?.toLocaleLowerCase("es") ?? "",
    ].join("|");

    const previousExternalRow = externalKeys.get(externalKey);
    if (previousExternalRow !== undefined) {
      errors.push({
        code: "DUPLICATE_EXTERNAL_ID",
        field: "external_id",
        message: `Duplicado de la fila ${previousExternalRow}.`,
        row: rowNumber,
        value: point.externalId,
      });
    }
    const previousSignatureRow = signatures.get(signature);
    if (previousSignatureRow !== undefined) {
      errors.push({
        code: "DUPLICATE_POINT",
        field: "row",
        message: `Misma ubicación y dirección que la fila ${previousSignatureRow}.`,
        row: rowNumber,
      });
    }

    if (errors.length > rowErrorsBefore) {
      duplicateRows += 1;
      return;
    }
    externalKeys.set(externalKey, rowNumber);
    signatures.set(signature, rowNumber);
    rows.push(point);
  });

  const invalidRows = new Set(errors.filter((error) => error.row > 1).map((error) => error.row))
    .size;
  return {
    errors,
    rows,
    summary: {
      duplicateRows,
      invalidRows,
      totalRows: dataRows.length,
      validRows: rows.length,
    },
    valid: errors.length === 0 && rows.length > 0,
  };
}

export function canonicalImportHash(input: {
  routeName: string;
  rows: readonly CanonicalRoutePoint[];
  sectorName: string;
}): string {
  const canonical = {
    routeName: input.routeName.trim(),
    rows: input.rows.map((point) => ({
      externalId: point.externalId,
      latitude: point.latitude,
      longitude: point.longitude,
      number: point.number ?? null,
      pointType: point.pointType,
      source: point.source,
      street: point.street ?? null,
    })),
    sectorName: input.sectorName.trim(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
