import { describe, expect, it, vi } from "vitest";
import type { RouteMapData } from "./geojson";
import { addStreetDirectionLayers, STREET_DIRECTION_LAYER_IDS } from "./streetDirectionLayers";

describe("addStreetDirectionLayers", () => {
  it("crea marcadores locales distintos para inicio y fin", () => {
    const addSource = vi.fn();
    const addLayer = vi.fn();
    const directions: RouteMapData["streetDirections"] = {
      type: "FeatureCollection",
      features: [],
    };

    addStreetDirectionLayers({ addLayer, addSource } as never, directions);

    expect(addSource).toHaveBeenCalledWith("route-street-directions", {
      type: "geojson",
      data: directions,
    });
    expect(addLayer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: STREET_DIRECTION_LAYER_IDS.start,
        filter: ["==", ["get", "marker"], "START"],
      }),
    );
    expect(addLayer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: STREET_DIRECTION_LAYER_IDS.end,
        filter: ["==", ["get", "marker"], "END"],
      }),
    );
  });
});
