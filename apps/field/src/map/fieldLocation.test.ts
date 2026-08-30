import { describe, expect, it } from "vitest";
import {
  buildFieldLocationCollection,
  EMPTY_FIELD_LOCATION_COLLECTION,
  FIELD_LOCATION_ZOOM,
  formatLocationAccuracy,
  geolocationErrorMessage,
} from "./fieldLocation";

describe("fieldLocation", () => {
  it("construye solo el punto GPS, sin anillos ni orbes alrededor", () => {
    const collection = buildFieldLocationCollection({
      accuracy: 12,
      latitude: -0.4489,
      longitude: -0.6693,
      timestamp: 123,
    });

    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.geometry).toEqual({
      type: "Point",
      coordinates: [-0.6693, -0.4489],
    });
    expect(collection.features[0]?.properties).toEqual({ accuracyMeters: 12, kind: "position" });
    expect(EMPTY_FIELD_LOCATION_COLLECTION.features).toHaveLength(0);
  });

  it("usa un zoom de viviendas y presenta la precisión de forma compacta", () => {
    expect(FIELD_LOCATION_ZOOM).toBeGreaterThanOrEqual(18);
    expect(FIELD_LOCATION_ZOOM).toBeLessThan(19);
    expect(formatLocationAccuracy(8.6)).toBe("precisión ±9 m");
    expect(formatLocationAccuracy(1_250)).toBe("precisión ±1.3 km");
  });

  it("prioriza HTTPS y distingue los errores útiles para el usuario", () => {
    expect(geolocationErrorMessage(1, false)).toContain("HTTPS");
    expect(geolocationErrorMessage(1, true)).toContain("bloqueada");
    expect(geolocationErrorMessage(2, true)).toContain("GPS");
    expect(geolocationErrorMessage(3, true)).toContain("tardó demasiado");
  });
});
