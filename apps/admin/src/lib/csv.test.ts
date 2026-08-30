import { describe, expect, it } from "vitest";
import { CANONICAL_CSV_COLUMNS, parseRouteCsv, serializeRoutePointsCsv } from "./csv";

describe("parseRouteCsv", () => {
  it("acepta la cabecera canónica y normaliza tipo y fuente", () => {
    const result = parseRouteCsv(
      [
        CANONICAL_CSV_COLUMNS.join(","),
        "home-001,Los Aromos,120A,-0.4512,-0.6621,dwelling,csv",
        "access-002,,, -0.4520,-0.6610,COMPLEX_ACCESS,MANUAL",
      ].join("\n"),
    );

    expect(result.globalErrors).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.validRows).toHaveLength(2);
    expect(result.validRows[0]).toMatchObject({
      externalId: "home-001",
      street: "Los Aromos",
      number: "120A",
      latitude: -0.4512,
      longitude: -0.6621,
      pointType: "DWELLING",
      source: "CSV",
    });
    expect(result.validRows[1]).toMatchObject({ street: "", number: "" });
  });

  it("informa rangos, enums e identificadores o puntos duplicados por fila", () => {
    const result = parseRouteCsv(
      [
        CANONICAL_CSV_COLUMNS.join(","),
        "bad-range,Calle,1,-95,-70,DWELLING,CSV",
        ",Calle,2,-33,-70,UNKNOWN,OTHER",
        "home-003,Calle,3,-33,-70,DWELLING,CSV",
        "HOME-003,Calle,4,-0.1,-0.1,DWELLING,CSV",
        "home-005,Calle,3,-33,-70,SPECIAL,OSM",
      ].join("\n"),
    );

    expect(result.rows[0].errors).toContain("La latitud debe estar entre -90 y 90.");
    expect(result.rows[1].errors).toEqual(
      expect.arrayContaining([
        "El identificador externo es obligatorio.",
        expect.stringContaining("Tipo de punto inválido"),
        expect.stringContaining("Fuente inválida"),
      ]),
    );
    expect(result.rows[3].errors[0]).toContain("Identificador externo duplicado");
    expect(result.rows[4].errors[0]).toContain("Misma ubicación y dirección");
    expect(result.validRows).toHaveLength(1);
  });

  it("rechaza aliases o un orden distinto y explica la cabecera exacta", () => {
    const result = parseRouteCsv("calle,numero,latitud,longitud\nLos Aromos,120,-33,-70");

    expect(result.globalErrors).toEqual([
      "Cabecera esperada: external_id,street,number,latitude,longitude,point_type,source.",
    ]);
  });

  it("marca filas con una cantidad distinta de siete columnas", () => {
    const result = parseRouteCsv(
      `${CANONICAL_CSV_COLUMNS.join(",")}\nhome-001,Los Aromos,120,-33,-70,DWELLING`,
    );

    expect(result.rows[0].errors).toEqual(["Se esperaban 7 columnas y se recibieron 6."]);
  });

  it("serializa los puntos actuales y conserva celdas con comas o comillas", () => {
    const csv = serializeRoutePointsCsv([
      {
        id: "point-1",
        externalId: 'home-"001"',
        servicePointVersionId: "version-1",
        street: "Los Aromos, norte",
        number: "120A",
        latitude: -0.4512,
        longitude: -0.6621,
        pointType: "DWELLING",
        source: "CSV",
      },
    ]);

    expect(csv.startsWith(CANONICAL_CSV_COLUMNS.join(","))).toBe(true);
    expect(parseRouteCsv(csv).validRows[0]).toMatchObject({
      externalId: 'home-"001"',
      street: "Los Aromos, norte",
      number: "120A",
    });
  });
});
