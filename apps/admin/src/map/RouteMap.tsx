import type { StyleSpecification } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { RoutePoint } from "../api/types";
import { SchematicMap } from "../components/Shared";
import {
  buildRouteMapData,
  type MapBoundaryInput,
  type MapStreetInput,
  supportsWebGl2,
} from "./geojson";
import { StreetLegend } from "./StreetLegend";
import { addStreetDirectionLayers } from "./streetDirectionLayers";

maplibregl.setWorkerUrl(workerUrl);

const LOCAL_STYLE: StyleSpecification = {
  version: 8,
  name: "RutaCuadrilla local",
  sources: {},
  layers: [
    {
      id: "local-background",
      type: "background",
      paint: { "background-color": "#f4f0e5" },
    },
  ],
};

interface RouteMapProps {
  boundary?: MapBoundaryInput;
  points: RoutePoint[];
  onMapClick?: (longitude: number, latitude: number) => void;
  onPointSelect?: (pointId: string) => void;
  selectedPointId?: string;
  streets?: MapStreetInput[];
  title: string;
}

export function RouteMap({
  boundary,
  onMapClick,
  onPointSelect,
  points,
  selectedPointId,
  streets = [],
  title,
}: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const onMapClickRef = useRef(onMapClick);
  const onPointSelectRef = useRef(onPointSelect);
  const selectedPointIdRef = useRef(selectedPointId);
  const descriptionId = useId();
  const [fallbackReason, setFallbackReason] = useState("");
  const data = useMemo(
    () => buildRouteMapData(points, streets, boundary),
    [boundary, points, streets],
  );
  onMapClickRef.current = onMapClick;
  onPointSelectRef.current = onPointSelect;
  selectedPointIdRef.current = selectedPointId;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || (points.length === 0 && streets.length === 0)) return;
    if (!supportsWebGl2()) {
      setFallbackReason("Este navegador no ofrece WebGL2.");
      return;
    }

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: import.meta.env.VITE_MAP_STYLE_URL?.trim() || LOCAL_STYLE,
        center: data.bounds
          ? [(data.bounds[0] + data.bounds[2]) / 2, (data.bounds[1] + data.bounds[3]) / 2]
          : [-0.6693, -0.4489],
        zoom: 13,
        attributionControl: { compact: false },
      });
    } catch {
      setFallbackReason("No fue posible iniciar el mapa acelerado.");
      return;
    }

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.once("load", () => {
      map.addSource("route-boundary", { type: "geojson", data: data.boundary });
      map.addLayer({
        id: "route-boundary-fill",
        type: "fill",
        source: "route-boundary",
        paint: { "fill-color": "#1e6171", "fill-opacity": 0.08 },
      });
      map.addLayer({
        id: "route-boundary-line",
        type: "line",
        source: "route-boundary",
        paint: { "line-color": "#1e6171", "line-width": 2, "line-dasharray": [2, 2] },
      });

      map.addSource("route-streets", { type: "geojson", data: data.streets });
      map.addLayer({
        id: "route-streets-line",
        type: "line",
        source: "route-streets",
        paint: { "line-color": "#68777c", "line-width": 8, "line-opacity": 0.26 },
      });
      map.addLayer({
        id: "route-streets-single-side",
        type: "line",
        source: "route-streets",
        filter: ["!=", ["get", "serviceSide"], "BOTH"],
        paint: {
          "line-color": [
            "match",
            ["get", "serviceSide"],
            "LEFT",
            "#1d4ed8",
            "RIGHT",
            "#c2410c",
            "#68777c",
          ],
          "line-offset": ["match", ["get", "serviceSide"], "LEFT", -4, "RIGHT", 4, 0],
          "line-width": 4,
        },
      });
      map.addLayer({
        id: "route-streets-both-left",
        type: "line",
        source: "route-streets",
        filter: ["==", ["get", "serviceSide"], "BOTH"],
        paint: { "line-color": "#6d28d9", "line-offset": -4, "line-width": 3 },
      });
      map.addLayer({
        id: "route-streets-both-right",
        type: "line",
        source: "route-streets",
        filter: ["==", ["get", "serviceSide"], "BOTH"],
        paint: { "line-color": "#6d28d9", "line-offset": 4, "line-width": 3 },
      });
      addStreetDirectionLayers(map, data.streetDirections);

      map.addSource("route-line", { type: "geojson", data: data.routeLine });
      map.addLayer({
        id: "route-line-layer",
        type: "line",
        source: "route-line",
        paint: { "line-color": "#b64a27", "line-width": 2, "line-dasharray": [3, 2] },
      });

      map.addSource("route-points", {
        type: "geojson",
        data: data.points,
        cluster: true,
        clusterMaxZoom: 16,
        clusterRadius: 48,
      });
      map.addLayer({
        id: "route-selected-point",
        type: "circle",
        source: "route-points",
        filter: ["==", ["get", "pointId"], selectedPointIdRef.current ?? ""],
        paint: {
          "circle-color": "rgba(0,0,0,0)",
          "circle-radius": 13,
          "circle-stroke-color": "#111827",
          "circle-stroke-width": 4,
        },
      });
      map.addLayer({
        id: "route-clusters",
        type: "circle",
        source: "route-points",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#1e6171",
          "circle-radius": ["step", ["get", "point_count"], 18, 100, 23, 1_000, 29],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "route-unclustered-points",
        type: "circle",
        source: "route-points",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "#b64a27",
          "circle-radius": 7,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });

      if (data.bounds) {
        const [west, south, east, north] = data.bounds;
        map.fitBounds(
          west === east && south === north
            ? [
                [west - 0.001, south - 0.001],
                [east + 0.001, north + 0.001],
              ]
            : [
                [west, south],
                [east, north],
              ],
          { padding: 40, maxZoom: 17, duration: 0 },
        );
      }

      map.on(
        "click",
        "route-unclustered-points",
        (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          const pointId = event.features?.[0]?.properties?.pointId;
          if (typeof pointId === "string") onPointSelectRef.current?.(pointId);
        },
      );
      map.on("click", (event: maplibregl.MapMouseEvent) =>
        onMapClickRef.current?.(event.lngLat.lng, event.lngLat.lat),
      );
    });

    return () => {
      mapRef.current = null;
      map.remove();
    };
  }, [data, points.length, streets.length]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("route-selected-point")) {
      map.setFilter("route-selected-point", ["==", ["get", "pointId"], selectedPointId ?? ""]);
    }
  }, [selectedPointId]);

  if (points.length === 0 && streets.length === 0) {
    return <SchematicMap points={points} title={title} />;
  }

  if (fallbackReason) {
    return (
      <div className="route-map-fallback">
        <p role="status">{fallbackReason} Se muestra la vista esquemática accesible.</p>
        <SchematicMap points={points} title={title} />
      </div>
    );
  }

  return (
    <section className="route-map" aria-labelledby={descriptionId}>
      <p id={descriptionId} className="route-map__description">
        {title}. {points.length.toLocaleString("es-CL")} puntos; el mapa agrupa marcadores al
        alejarse.
        {streets.length > 0
          ? " " +
            streets.length.toLocaleString("es-CL") +
            " trazos de calle muestran el lado atendido, siempre relativo al orden de sus coordenadas."
          : ""}{" "}
        La información posterior ofrece el mismo contenido sin depender del color ni del mapa.
      </p>
      <div ref={containerRef} className="route-map__canvas" aria-hidden="true" />
      <div className="route-map__footer">
        <span>
          Mapa base: {import.meta.env.VITE_MAP_STYLE_URL ? "proveedor configurado" : "ninguno"}
        </span>
        {data.hasOsmData ? (
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            © OpenStreetMap contributors
          </a>
        ) : null}
        {streets.length > 0 ? <StreetLegend /> : null}
      </div>
    </section>
  );
}
