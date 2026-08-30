import type { Map as MapLibreMap } from "maplibre-gl";
import type { RouteMapData } from "./geojson";

export const STREET_DIRECTION_LAYER_IDS = {
  end: "route-street-direction-end",
  start: "route-street-direction-start",
} as const;

type DirectionLayerMap = Pick<MapLibreMap, "addLayer" | "addSource">;

export function addStreetDirectionLayers(
  map: DirectionLayerMap,
  directions: RouteMapData["streetDirections"],
): void {
  map.addSource("route-street-directions", { type: "geojson", data: directions });
  map.addLayer({
    id: STREET_DIRECTION_LAYER_IDS.start,
    type: "circle",
    source: "route-street-directions",
    filter: ["==", ["get", "marker"], "START"],
    paint: {
      "circle-color": "#166534",
      "circle-radius": 5,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: STREET_DIRECTION_LAYER_IDS.end,
    type: "circle",
    source: "route-street-directions",
    filter: ["==", ["get", "marker"], "END"],
    paint: {
      "circle-color": "#ffffff",
      "circle-radius": 7,
      "circle-stroke-color": "#991b1b",
      "circle-stroke-width": 3,
    },
  });
}
