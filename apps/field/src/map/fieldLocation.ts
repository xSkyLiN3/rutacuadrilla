import type { FeatureCollection, Point } from "geojson";

/**
 * En Santiago, este zoom muestra aproximadamente 150-190 metros de ancho en
 * un teléfono habitual. Permite distinguir viviendas cercanas sin abrir una
 * parte excesiva de la ruta.
 */
export const FIELD_LOCATION_ZOOM = 18.25;

export interface FieldLiveLocation {
  accuracy: number;
  latitude: number;
  longitude: number;
  timestamp: number;
}

type FieldLocationProperties = {
  accuracyMeters: number;
  kind: "position";
};

export const EMPTY_FIELD_LOCATION_COLLECTION: FeatureCollection<Point, FieldLocationProperties> = {
  type: "FeatureCollection",
  features: [],
};

export function buildFieldLocationCollection(
  location: FieldLiveLocation | null,
): FeatureCollection<Point, FieldLocationProperties> {
  if (!location) return EMPTY_FIELD_LOCATION_COLLECTION;

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { accuracyMeters: location.accuracy, kind: "position" },
        geometry: {
          type: "Point",
          coordinates: [location.longitude, location.latitude],
        },
      },
    ],
  };
}

export function formatLocationAccuracy(accuracy: number): string {
  if (!Number.isFinite(accuracy)) return "precisión desconocida";
  if (accuracy >= 1_000) return `precisión ±${(accuracy / 1_000).toFixed(1)} km`;
  return `precisión ±${Math.max(1, Math.round(accuracy))} m`;
}

export function geolocationErrorMessage(code: number, secureContext: boolean): string {
  if (!secureContext) {
    return "La ubicación necesita una conexión HTTPS segura en el teléfono.";
  }
  if (code === 1) {
    return "La ubicación está bloqueada. Permítela para este sitio en el navegador.";
  }
  if (code === 2) {
    return "No se pudo determinar tu ubicación. Revisa que el GPS esté activo.";
  }
  if (code === 3) {
    return "El GPS tardó demasiado. Muévete a un lugar con mejor señal e inténtalo de nuevo.";
  }
  return "No fue posible iniciar la ubicación en este dispositivo.";
}
