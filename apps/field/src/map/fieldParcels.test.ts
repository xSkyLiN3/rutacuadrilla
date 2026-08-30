import { describe, expect, it } from "vitest";
import type { FieldPoint } from "../types";
import { buildFieldParcelCollection, parseFieldParcelCatalog } from "./fieldParcels";

const point: FieldPoint = {
  id: "point-1",
  displayOrder: 7,
  externalId: "synthetic/dwelling/001",
  latitude: 0.001,
  longitude: 0.002,
  number: "120",
  pointType: "DWELLING",
  state: "SIN_VISITAR",
  street: "Pasaje Horizonte",
  version: 0,
};

const catalogInput = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { externalId: "synthetic/dwelling/001" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0.0019, 0.0009],
            [0.0021, 0.0009],
            [0.0021, 0.0011],
            [0.0019, 0.0011],
            [0.0019, 0.0009],
          ],
        ],
      },
    },
  ],
};

describe("field parcel GeoJSON", () => {
  it("filtra el catálogo por la ruta activa y enlaza selección y punto", () => {
    const catalog = parseFieldParcelCatalog(catalogInput);
    catalog.features.push({
      ...catalog.features[0],
      properties: { externalId: "synthetic/dwelling/999" },
    });

    expect(buildFieldParcelCollection(catalog, [point], point.id)).toEqual({
      type: "FeatureCollection",
      features: [
        {
          ...catalog.features[0],
          id: 7,
          properties: {
            externalId: "synthetic/dwelling/001",
            pointId: point.id,
            selected: true,
          },
        },
      ],
    });
  });

  it("rechaza geometrías inválidas e identificadores duplicados", () => {
    expect(() =>
      parseFieldParcelCatalog({
        ...catalogInput,
        features: [catalogInput.features[0], catalogInput.features[0]],
      }),
    ).toThrow(/repite synthetic\/dwelling\/001/u);
    expect(() =>
      parseFieldParcelCatalog({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { externalId: "synthetic/dwelling/001" },
            geometry: { type: "Point", coordinates: [0.002, 0.001] },
          },
        ],
      }),
    ).toThrow(/polígono válido/u);
  });
});
