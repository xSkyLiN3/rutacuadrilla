import { describe, expect, it } from "vitest";
import { canonicalCsvColumns, previewRouteCsv } from "../src/index.js";
import { validCsv } from "./helpers.js";

describe("canonical route CSV", () => {
  it("normalizes valid rows and exposes the exact canonical header", () => {
    const preview = previewRouteCsv(validCsv);

    expect(canonicalCsvColumns).toEqual([
      "external_id",
      "street",
      "number",
      "latitude",
      "longitude",
      "point_type",
      "source",
    ]);
    expect(preview).toMatchObject({
      errors: [],
      summary: {
        duplicateRows: 0,
        invalidRows: 0,
        totalRows: 2,
        validRows: 2,
      },
      valid: true,
    });
    expect(preview.rows[0]).toMatchObject({
      externalId: "home-001",
      latitude: -0.4489,
      longitude: -0.6693,
      number: "101",
      pointType: "DWELLING",
      source: "CSV",
      street: "Los Aromos",
    });
  });

  it("reports malformed headers, WGS84 bounds, enums and duplicates by row", () => {
    const badHeader = previewRouteCsv("id,lat\n1,-33");
    expect(badHeader.valid).toBe(false);
    expect(badHeader.errors[0]?.code).toBe("CSV_HEADER_INVALID");

    const invalidRows =
      previewRouteCsv(`external_id,street,number,latitude,longitude,point_type,source
same,Calle,1,-91,-70,DWELLING,CSV
same,Calle,1,-33,-181,UNKNOWN,OTHER`);
    expect(invalidRows.valid).toBe(false);
    expect(invalidRows.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_LATITUDE", row: 2 }),
        expect.objectContaining({ code: "INVALID_LONGITUDE", row: 3 }),
        expect.objectContaining({ code: "INVALID_POINT_TYPE", row: 3 }),
        expect.objectContaining({ code: "INVALID_SOURCE", row: 3 }),
      ]),
    );

    const duplicates = previewRouteCsv(`${validCsv}
HOME-001,Los Aromos,105,-0.4491,-0.6695,DWELLING,CSV
home-004,Los Aromos,103,-0.4490,-0.6694,DWELLING,CSV`);
    expect(duplicates.valid).toBe(false);
    expect(duplicates.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_EXTERNAL_ID", row: 4 }),
        expect.objectContaining({ code: "DUPLICATE_POINT", row: 5 }),
      ]),
    );
    expect(duplicates.summary.duplicateRows).toBe(2);
  });
});
