import type { ExpressionSpecification, GeoJSONSource, StyleSpecification } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { PointStatePanel } from "../PointStatePanel";
import { POINT_STATE_LABELS, type PointFeedback } from "../pointStates";
import { formatFieldSegmentSide, SERVICE_SIDE_LABELS } from "../streetSide";
import type { FieldPoint, FieldSegment, PointState, ServiceSide } from "../types";
import {
  buildFieldPointCollection,
  buildFieldSegmentCollection,
  fieldBounds,
  findNearestFieldPointId,
} from "./fieldGeojson";
import {
  buildFieldLocationCollection,
  EMPTY_FIELD_LOCATION_COLLECTION,
  FIELD_LOCATION_ZOOM,
  type FieldLiveLocation,
  formatLocationAccuracy,
  geolocationErrorMessage,
} from "./fieldLocation";
import {
  buildFieldParcelCollection,
  EMPTY_FIELD_PARCEL_CATALOG,
  parseFieldParcelCatalog,
} from "./fieldParcels";
import {
  type LocationMotionState,
  locationDistanceMeters,
  sampleLocationMotion,
  smoothLocationProgress,
  updateLocationMotion,
} from "./locationMotion";

maplibregl.setWorkerUrl(workerUrl);

const LOCAL_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "field-background",
      type: "background",
      paint: { "background-color": "#f2efe6" },
    },
  ],
};

const STATE_COLORS: ExpressionSpecification = [
  "match",
  ["get", "state"],
  "SIN_VISITAR",
  "#68777c",
  "SOBRE_ENTREGADO",
  "#166534",
  "VOLVER",
  "#c2410c",
  "SIN_RESPUESTA",
  "#7c3aed",
  "APORTO",
  "#0f766e",
  "NO_PARTICIPA",
  "#9f1239",
  "#68777c",
];

const STATE_RADII: ExpressionSpecification = [
  "match",
  ["get", "state"],
  "SIN_VISITAR",
  4,
  "SOBRE_ENTREGADO",
  5,
  "VOLVER",
  6,
  "SIN_RESPUESTA",
  5,
  "APORTO",
  7,
  "NO_PARTICIPA",
  6,
  4,
];

const STATE_LEGEND: Array<{ color: string; label: string; size: number; state: PointState }> = [
  { state: "SIN_VISITAR", label: POINT_STATE_LABELS.SIN_VISITAR, color: "#68777c", size: 7 },
  {
    state: "SOBRE_ENTREGADO",
    label: POINT_STATE_LABELS.SOBRE_ENTREGADO,
    color: "#166534",
    size: 9,
  },
  { state: "VOLVER", label: POINT_STATE_LABELS.VOLVER, color: "#c2410c", size: 11 },
  {
    state: "SIN_RESPUESTA",
    label: POINT_STATE_LABELS.SIN_RESPUESTA,
    color: "#7c3aed",
    size: 8,
  },
  { state: "APORTO", label: POINT_STATE_LABELS.APORTO, color: "#0f766e", size: 12 },
  {
    state: "NO_PARTICIPA",
    label: POINT_STATE_LABELS.NO_PARTICIPA,
    color: "#9f1239",
    size: 10,
  },
];

const SERVICE_SIDE_COLORS: ExpressionSpecification = [
  "match",
  ["get", "serviceSide"],
  "LEFT",
  "#2563eb",
  "RIGHT",
  "#c2410c",
  "BOTH",
  "#0f766e",
  "#475569",
];

const SERVICE_SIDE_OFFSETS: ExpressionSpecification = [
  "match",
  ["get", "serviceSide"],
  "LEFT",
  -5,
  "RIGHT",
  5,
  0,
];

const SERVICE_SIDE_WIDTHS: ExpressionSpecification = [
  "match",
  ["get", "serviceSide"],
  "BOTH",
  9,
  5,
];

const SERVICE_SIDE_LEGEND: Array<{ color: string; serviceSide: ServiceSide }> = [
  { serviceSide: "LEFT", color: "#2563eb" },
  { serviceSide: "RIGHT", color: "#c2410c" },
  { serviceSide: "BOTH", color: "#0f766e" },
];

export interface FieldMapCatalogs {
  attribution?: { label: string; url?: string };
  dwellings?: string;
  parcels?: string;
}

export const SYNTHETIC_FIELD_CATALOGS: FieldMapCatalogs = {
  attribution: {
    label: "datos sintéticos de demostración; no representan ubicaciones reales",
  },
  dwellings: "demo-dwellings.geojson",
  parcels: "demo-parcels.geojson",
};

interface FieldMapProps {
  catalogs?: FieldMapCatalogs | null;
  feedback?: PointFeedback | null;
  online?: boolean;
  onClearSelection?(): void;
  onSelect(pointId: string): void;
  onSetPointState?(point: FieldPoint, state: PointState): void;
  points: FieldPoint[];
  savingPointId?: string;
  savingState?: PointState | null;
  segments: FieldSegment[];
  selectedPointId?: string;
}

interface HoveredPoint {
  address: string;
  x: number;
  y: number;
}

type LocationPhase = "error" | "idle" | "requesting" | "tracking";

function hasSecureGeolocationContext(): boolean {
  return Boolean(
    window.isSecureContext ||
      window.location.protocol === "https:" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1",
  );
}

export function FieldMap({
  catalogs = SYNTHETIC_FIELD_CATALOGS,
  feedback,
  online = true,
  onClearSelection,
  onSelect,
  onSetPointState,
  points,
  savingPointId,
  savingState,
  segments,
  selectedPointId,
}: FieldMapProps) {
  const mapSectionRef = useRef<HTMLElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const pointsRef = useRef(points);
  const dataRef = useRef(buildFieldPointCollection(points));
  const segmentDataRef = useRef(buildFieldSegmentCollection(segments));
  const parcelDataRef = useRef(
    buildFieldParcelCollection(EMPTY_FIELD_PARCEL_CATALOG, points, selectedPointId),
  );
  const dwellingDataRef = useRef(
    buildFieldParcelCollection(EMPTY_FIELD_PARCEL_CATALOG, points, selectedPointId),
  );
  const locationDataRef = useRef(EMPTY_FIELD_LOCATION_COLLECTION);
  const liveLocationRef = useRef<FieldLiveLocation | null>(null);
  const locationMotionRef = useRef<LocationMotionState | null>(null);
  const locationAnimationFrameRef = useRef<number | null>(null);
  const locationWatchRef = useRef<number | null>(null);
  const followingLocationRef = useRef(false);
  const fullscreenRequestRef = useRef(0);
  const boundsRef = useRef(fieldBounds(points, segments));
  const onSelectRef = useRef(onSelect);
  const onClearSelectionRef = useRef(onClearSelection);
  const selectedPointIdRef = useRef(selectedPointId);
  const savingPointIdRef = useRef(savingPointId);
  const selectionFocusRef = useRef<HTMLElement | null>(null);
  const descriptionId = useId();
  const [query, setQuery] = useState("");
  const [segmentQuery, setSegmentQuery] = useState("");
  const [selectedSegmentId, setSelectedSegmentId] = useState("");
  const [fallback, setFallback] = useState(false);
  const [hoveredPoint, setHoveredPoint] = useState<HoveredPoint | null>(null);
  const [parcelCatalog, setParcelCatalog] = useState(EMPTY_FIELD_PARCEL_CATALOG);
  const [dwellingCatalog, setDwellingCatalog] = useState(EMPTY_FIELD_PARCEL_CATALOG);
  const [liveLocation, setLiveLocation] = useState<FieldLiveLocation | null>(null);
  const [locationPhase, setLocationPhase] = useState<LocationPhase>("idle");
  const [locationError, setLocationError] = useState("");
  const [followingLocation, setFollowingLocation] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false);
  const data = useMemo(() => buildFieldPointCollection(points), [points]);
  const segmentData = useMemo(() => buildFieldSegmentCollection(segments), [segments]);
  const parcelData = useMemo(
    () => buildFieldParcelCollection(parcelCatalog, points, selectedPointId),
    [parcelCatalog, points, selectedPointId],
  );
  const dwellingData = useMemo(
    () => buildFieldParcelCollection(dwellingCatalog, points, selectedPointId),
    [dwellingCatalog, points, selectedPointId],
  );
  const selectedPoint = points.find((point) => point.id === selectedPointId);
  const editingEnabled = Boolean(onSetPointState);
  const fullscreen = nativeFullscreen || fallbackFullscreen;
  const parcelCatalogPath = catalogs?.parcels?.trim() ?? "";
  const dwellingCatalogPath = catalogs?.dwellings?.trim() ?? "";
  const catalogAttribution = catalogs?.attribution;
  dataRef.current = data;
  segmentDataRef.current = segmentData;
  parcelDataRef.current = parcelData;
  dwellingDataRef.current = dwellingData;
  boundsRef.current = fieldBounds(points, segments);
  pointsRef.current = points;
  onSelectRef.current = onSelect;
  onClearSelectionRef.current = onClearSelection;
  selectedPointIdRef.current = selectedPointId;
  savingPointIdRef.current = savingPointId;

  function centerOnLiveLocation(location: FieldLiveLocation, duration = 550): void {
    mapRef.current?.easeTo({
      center: [location.longitude, location.latitude],
      duration,
      easing: smoothLocationProgress,
      zoom: FIELD_LOCATION_ZOOM,
    });
  }

  function publishAnimatedLocation(location: FieldLiveLocation): void {
    const collection = buildFieldLocationCollection(location);
    locationDataRef.current = collection;
    const source = mapRef.current?.getSource("field-location") as GeoJSONSource | undefined;
    source?.setData(collection);
  }

  function renderLocationMotionFrame(): void {
    const motion = locationMotionRef.current;
    if (!motion) {
      locationAnimationFrameRef.current = null;
      return;
    }

    const sample = sampleLocationMotion(motion, performance.now());
    publishAnimatedLocation(sample.location);
    if (sample.settled) {
      locationAnimationFrameRef.current = null;
      return;
    }
    locationAnimationFrameRef.current = window.requestAnimationFrame(renderLocationMotionFrame);
  }

  function animateToLiveLocation(motion: LocationMotionState): void {
    locationMotionRef.current = motion;
    if (locationAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(locationAnimationFrameRef.current);
      locationAnimationFrameRef.current = null;
    }
    renderLocationMotionFrame();
  }

  const stopFollowingLocation = useCallback((): void => {
    if (!followingLocationRef.current) return;
    followingLocationRef.current = false;
    setFollowingLocation(false);
  }, []);

  function startOrCenterLocation(): void {
    const secureContext = hasSecureGeolocationContext();
    if (!secureContext) {
      setLocationPhase("error");
      setLocationError(geolocationErrorMessage(1, false));
      return;
    }
    if (!navigator.geolocation) {
      setLocationPhase("error");
      setLocationError("Este navegador no ofrece ubicación GPS.");
      return;
    }

    followingLocationRef.current = true;
    setFollowingLocation(true);
    if (liveLocationRef.current) centerOnLiveLocation(liveLocationRef.current);
    if (locationWatchRef.current !== null) return;

    setLocationError("");
    setLocationPhase("requesting");
    try {
      locationWatchRef.current = navigator.geolocation.watchPosition(
        (position) => {
          const measurement: FieldLiveLocation = {
            accuracy: position.coords.accuracy,
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            timestamp: position.timestamp,
          };
          const previousLocation = liveLocationRef.current;
          const nextMotion = updateLocationMotion(
            locationMotionRef.current,
            measurement,
            performance.now(),
          );
          if (!nextMotion || nextMotion === locationMotionRef.current) return;

          const firstMeasurement = previousLocation === null;
          const nextLocation = nextMotion.target;
          animateToLiveLocation(nextMotion);
          liveLocationRef.current = nextLocation;
          setLiveLocation(nextLocation);
          setLocationError("");
          setLocationPhase("tracking");
          const moved =
            firstMeasurement ||
            (previousLocation !== null &&
              locationDistanceMeters(previousLocation, nextLocation) >= 0.25);
          if (followingLocationRef.current && moved) {
            centerOnLiveLocation(
              nextLocation,
              firstMeasurement ? 800 : nextMotion.transitionDurationMs,
            );
          }
        },
        (error) => {
          if (locationWatchRef.current !== null) {
            navigator.geolocation.clearWatch(locationWatchRef.current);
            locationWatchRef.current = null;
          }
          followingLocationRef.current = false;
          setFollowingLocation(false);
          setLocationPhase("error");
          setLocationError(geolocationErrorMessage(error.code, true));
        },
        {
          enableHighAccuracy: true,
          maximumAge: 1_000,
          timeout: 15_000,
        },
      );
    } catch {
      followingLocationRef.current = false;
      setFollowingLocation(false);
      setLocationPhase("error");
      setLocationError("No fue posible iniciar la ubicación en este dispositivo.");
    }
  }

  async function toggleFullscreen(): Promise<void> {
    const section = mapSectionRef.current;
    if (!section) return;
    const requestId = fullscreenRequestRef.current + 1;
    fullscreenRequestRef.current = requestId;

    if (fullscreen) {
      setFallbackFullscreen(false);
      if (document.fullscreenElement === section && document.exitFullscreen) {
        try {
          await document.exitFullscreen();
        } catch {
          // Si el navegador no consigue salir, conservamos la interfaz de cierre activa.
          setNativeFullscreen(document.fullscreenElement === section);
          return;
        }
      }
      setNativeFullscreen(document.fullscreenElement === section);
      return;
    }

    // Se muestra al instante: algunos WebViews dejan pendiente `requestFullscreen` sin rechazarla.
    setFallbackFullscreen(true);
    if (section.requestFullscreen && document.fullscreenEnabled !== false) {
      try {
        await section.requestFullscreen({ navigationUI: "hide" });
        if (fullscreenRequestRef.current !== requestId) {
          if (document.fullscreenElement === section && document.exitFullscreen) {
            await document.exitFullscreen().catch(() => undefined);
          }
          return;
        }
        if (document.fullscreenElement === section) {
          setNativeFullscreen(true);
          setFallbackFullscreen(false);
          return;
        }
      } catch {
        // iOS y WebViews antiguos pueden exponer la API pero rechazarla.
      }
    }
    if (fullscreenRequestRef.current !== requestId) return;
    setNativeFullscreen(false);
    setFallbackFullscreen(true);
  }

  function clearSelectedPoint(restoreFocus = true): void {
    if (selectedPointIdRef.current && savingPointIdRef.current === selectedPointIdRef.current) {
      return;
    }
    if (onClearSelectionRef.current) onClearSelectionRef.current();
    else onSelectRef.current("");
    if (!restoreFocus) return;
    const focusTarget = selectionFocusRef.current;
    window.requestAnimationFrame(() => focusTarget?.focus({ preventScroll: true }));
  }

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("es");
    if (!normalized) return points.slice(0, 12);
    return points
      .filter((point) =>
        [point.externalId, point.street, point.number]
          .filter(Boolean)
          .some((value) => value?.toLocaleLowerCase("es").includes(normalized)),
      )
      .slice(0, 20);
  }, [points, query]);

  const segmentResults = useMemo(() => {
    const normalized = segmentQuery.trim().toLocaleLowerCase("es");
    if (!normalized) return segments.slice(0, 12);
    return segments
      .filter((segment) =>
        [segment.externalId, segment.name, formatFieldSegmentSide(segment)]
          .filter(Boolean)
          .some((value) => value?.toLocaleLowerCase("es").includes(normalized)),
      )
      .slice(0, 30);
  }, [segmentQuery, segments]);

  function focusSegment(segment: FieldSegment): void {
    setSelectedSegmentId(segment.id);
    const bounds = fieldBounds([], [segment]);
    if (bounds) mapRef.current?.fitBounds(bounds, { padding: 72, maxZoom: 18 });
  }

  useEffect(
    () => () => {
      if (locationWatchRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatchRef.current);
        locationWatchRef.current = null;
      }
      if (locationAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(locationAnimationFrameRef.current);
        locationAnimationFrameRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = document.fullscreenElement === mapSectionRef.current;
      setNativeFullscreen(active);
      if (active) setFallbackFullscreen(false);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!fallbackFullscreen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFallbackFullscreen(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [fallbackFullscreen]);

  useEffect(() => {
    if (!fullscreen) {
      mapRef.current?.resize();
      return;
    }

    const section = mapSectionRef.current;
    if (!section) return;
    const root = document.documentElement;
    const body = document.body;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const previousRootOverflow = root.style.overflow;
    const previousBodyStyles = {
      left: body.style.left,
      overflow: body.style.overflow,
      position: body.style.position,
      right: body.style.right,
      top: body.style.top,
      width: body.style.width,
    };
    const previousSectionStyles = {
      bottom: section.style.bottom,
      height: section.style.height,
      left: section.style.left,
      right: section.style.right,
      top: section.style.top,
      width: section.style.width,
    };
    let resizeFrame: number | null = null;
    let settleFrame: number | null = null;
    let orientationTimer: number | null = null;

    const scheduleMapResize = () => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        mapRef.current?.resize();
        settleFrame = window.requestAnimationFrame(() => {
          settleFrame = null;
          mapRef.current?.resize();
        });
      });
    };
    const syncVisibleViewport = () => {
      if (fallbackFullscreen) {
        const visibleViewport = window.visualViewport;
        const height = Math.max(1, Math.round(visibleViewport?.height ?? window.innerHeight));
        const width = Math.max(1, Math.round(visibleViewport?.width ?? window.innerWidth));
        section.style.bottom = "auto";
        section.style.height = `${height}px`;
        section.style.left = `${Math.round(visibleViewport?.offsetLeft ?? 0)}px`;
        section.style.right = "auto";
        section.style.top = `${Math.round(visibleViewport?.offsetTop ?? 0)}px`;
        section.style.width = `${width}px`;
      }
      scheduleMapResize();
    };
    const handleOrientationChange = () => {
      syncVisibleViewport();
      if (orientationTimer !== null) window.clearTimeout(orientationTimer);
      orientationTimer = window.setTimeout(syncVisibleViewport, 250);
    };

    root.classList.add("field-map-fullscreen-open");
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (fallbackFullscreen) {
      // `overflow: hidden` no bloquea por sí solo el documento en Safari para iPhone.
      body.style.left = `${-scrollX}px`;
      body.style.position = "fixed";
      body.style.right = "0";
      body.style.top = `${-scrollY}px`;
      body.style.width = "100%";
    }

    syncVisibleViewport();
    window.addEventListener("resize", syncVisibleViewport);
    window.addEventListener("orientationchange", handleOrientationChange);
    window.visualViewport?.addEventListener("resize", syncVisibleViewport);
    window.visualViewport?.addEventListener("scroll", syncVisibleViewport);
    window.screen.orientation?.addEventListener("change", handleOrientationChange);

    return () => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
      if (orientationTimer !== null) window.clearTimeout(orientationTimer);
      window.removeEventListener("resize", syncVisibleViewport);
      window.removeEventListener("orientationchange", handleOrientationChange);
      window.visualViewport?.removeEventListener("resize", syncVisibleViewport);
      window.visualViewport?.removeEventListener("scroll", syncVisibleViewport);
      window.screen.orientation?.removeEventListener("change", handleOrientationChange);
      root.classList.remove("field-map-fullscreen-open");
      root.style.overflow = previousRootOverflow;
      Object.assign(body.style, previousBodyStyles);
      Object.assign(section.style, previousSectionStyles);
      if (fallbackFullscreen && (window.scrollX !== scrollX || window.scrollY !== scrollY)) {
        window.scrollTo(scrollX, scrollY);
      }
      window.requestAnimationFrame(() => mapRef.current?.resize());
    };
  }, [fullscreen, fallbackFullscreen]);

  useEffect(() => {
    const controller = new AbortController();
    const catalogUrl = (path: string): string => {
      if (/^[a-z][a-z\d+.-]*:/iu.test(path) || path.startsWith("/")) return path;
      return `${import.meta.env.BASE_URL}${path.replace(/^\.\//u, "")}`;
    };
    async function loadCatalog(path: string, setCatalog: typeof setParcelCatalog): Promise<void> {
      try {
        const response = await fetch(catalogUrl(path), {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const catalog = parseFieldParcelCatalog(await response.json());
        if (!controller.signal.aborted) setCatalog(catalog);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // El mapa y las acciones siguen funcionando si un recurso catastral no está disponible.
      }
    }
    setParcelCatalog(EMPTY_FIELD_PARCEL_CATALOG);
    setDwellingCatalog(EMPTY_FIELD_PARCEL_CATALOG);
    const loads = [];
    if (parcelCatalogPath) loads.push(loadCatalog(parcelCatalogPath, setParcelCatalog));
    if (dwellingCatalogPath) loads.push(loadCatalog(dwellingCatalogPath, setDwellingCatalog));
    void Promise.all(loads);
    return () => controller.abort();
  }, [dwellingCatalogPath, parcelCatalogPath]);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || points.length === 0) return;
    try {
      const canvas = document.createElement("canvas");
      if (!canvas.getContext("webgl2")) {
        setFallback(true);
        return;
      }
      const map = new maplibregl.Map({
        container,
        clickTolerance: 10,
        style: import.meta.env.VITE_MAP_STYLE_URL?.trim() || LOCAL_STYLE,
        center: [-0.6693, -0.4489],
        locale: {
          "LogoControl.Title": "MapLibre",
          "Map.Title": "Mapa operativo",
          "NavigationControl.ResetBearing": "Restablecer orientación",
          "NavigationControl.ZoomIn": "Acercar",
          "NavigationControl.ZoomOut": "Alejar",
        },
        zoom: 13,
      });
      map.getCanvas().setAttribute("aria-describedby", descriptionId);
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.once("load", () => {
        map.addSource("field-parcels", {
          type: "geojson",
          data: parcelDataRef.current,
        });
        map.addLayer({
          id: "field-parcel-fills",
          type: "fill",
          source: "field-parcels",
          minzoom: 15,
          paint: {
            "fill-color": "#fef3c7",
            "fill-opacity": 0.16,
          },
        });
        map.addLayer({
          id: "field-parcel-outlines",
          type: "line",
          source: "field-parcels",
          minzoom: 15,
          paint: {
            "line-color": "#475569",
            "line-opacity": 0.46,
            "line-width": ["interpolate", ["linear"], ["zoom"], 15, 0.7, 18, 1.5],
          },
        });
        map.addLayer({
          id: "field-parcel-selected-fill",
          type: "fill",
          source: "field-parcels",
          filter: ["==", ["get", "selected"], true],
          paint: {
            "fill-color": "#fbbf24",
            "fill-opacity": 0.32,
          },
        });
        map.addLayer({
          id: "field-parcel-selected-outline",
          type: "line",
          source: "field-parcels",
          filter: ["==", ["get", "selected"], true],
          paint: {
            "line-color": "#92400e",
            "line-opacity": 0.95,
            "line-width": 3,
          },
        });
        map.addSource("field-dwellings", {
          type: "geojson",
          data: dwellingDataRef.current,
        });
        map.addLayer({
          id: "field-dwelling-fills",
          type: "fill",
          source: "field-dwellings",
          minzoom: 15,
          paint: {
            "fill-color": "#d1fae5",
            "fill-opacity": 0.2,
          },
        });
        map.addLayer({
          id: "field-dwelling-outlines",
          type: "line",
          source: "field-dwellings",
          minzoom: 15,
          paint: {
            "line-color": "#0f766e",
            "line-opacity": 0.88,
            "line-width": ["interpolate", ["linear"], ["zoom"], 15, 0.9, 18, 1.8],
          },
        });
        map.addLayer({
          id: "field-dwelling-selected-fill",
          type: "fill",
          source: "field-dwellings",
          filter: ["==", ["get", "selected"], true],
          paint: {
            "fill-color": "#fbbf24",
            "fill-opacity": 0.42,
          },
        });
        map.addLayer({
          id: "field-dwelling-selected-outline",
          type: "line",
          source: "field-dwellings",
          filter: ["==", ["get", "selected"], true],
          paint: {
            "line-color": "#92400e",
            "line-opacity": 1,
            "line-width": 3.5,
          },
        });
        map.addSource("field-segments", {
          type: "geojson",
          data: segmentDataRef.current,
        });
        map.addLayer({
          id: "field-segment-centerlines",
          type: "line",
          source: "field-segments",
          paint: {
            "line-color": "#334155",
            "line-opacity": 0.65,
            "line-width": 2,
          },
        });
        map.addLayer({
          id: "field-segment-service-sides",
          type: "line",
          source: "field-segments",
          paint: {
            "line-color": SERVICE_SIDE_COLORS,
            "line-offset": SERVICE_SIDE_OFFSETS,
            "line-opacity": 0.9,
            "line-width": SERVICE_SIDE_WIDTHS,
          },
        });
        map.addSource("field-points", {
          type: "geojson",
          data: dataRef.current,
        });
        map.addLayer({
          id: "field-points",
          type: "circle",
          source: "field-points",
          paint: {
            "circle-color": STATE_COLORS,
            "circle-radius": STATE_RADII,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1.5,
          },
        });
        map.addLayer({
          id: "field-point-hover",
          type: "circle",
          source: "field-points",
          filter: ["==", ["get", "pointId"], ""],
          paint: {
            "circle-color": STATE_COLORS,
            "circle-radius": 10,
            "circle-stroke-color": "#38bdf8",
            "circle-stroke-opacity": 0.95,
            "circle-stroke-width": 4,
          },
        });
        map.addLayer({
          id: "field-point-selection",
          type: "circle",
          source: "field-points",
          filter: ["==", ["get", "pointId"], selectedPointIdRef.current ?? ""],
          paint: {
            "circle-color": STATE_COLORS,
            "circle-radius": 10,
            "circle-stroke-color": "#fbbf24",
            "circle-stroke-opacity": 1,
            "circle-stroke-width": 4,
          },
        });
        map.addLayer({
          id: "field-point-hit-targets",
          type: "circle",
          source: "field-points",
          paint: {
            "circle-opacity": 0.01,
            "circle-radius": 26,
          },
        });
        map.addSource("field-location", {
          type: "geojson",
          data: locationDataRef.current,
        });
        map.addLayer({
          id: "field-location-position",
          type: "circle",
          source: "field-location",
          paint: {
            "circle-color": "#0b74de",
            "circle-radius": 7.5,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 3,
          },
        });
        let touchStart: { x: number; y: number } | null = null;
        let suppressClickUntil = 0;
        const activateMap = (target: { x: number; y: number }): boolean => {
          if (selectedPointIdRef.current) {
            if (savingPointIdRef.current === selectedPointIdRef.current) return true;
            onClearSelectionRef.current?.();
            if (!onClearSelectionRef.current) onSelectRef.current("");
            window.requestAnimationFrame(() => map.getCanvas().focus({ preventScroll: true }));
            return true;
          }
          const pointId = findNearestFieldPointId(
            pointsRef.current,
            (coordinates) => map.project(coordinates),
            target,
          );
          if (!pointId) return false;
          map.setFilter("field-point-hover", ["==", ["get", "pointId"], ""]);
          setHoveredPoint(null);
          selectionFocusRef.current = map.getCanvas();
          onSelectRef.current(pointId);
          return true;
        };
        map.on("click", (event) => {
          if (Date.now() < suppressClickUntil) return;
          activateMap(event.point);
        });
        map.on("touchstart", (event) => {
          touchStart = event.points.length === 1 ? event.point : null;
        });
        map.on("touchmove", (event) => {
          if (!touchStart || event.points.length !== 1) {
            touchStart = null;
            return;
          }
          if (Math.hypot(event.point.x - touchStart.x, event.point.y - touchStart.y) > 10) {
            touchStart = null;
          }
        });
        map.on("touchcancel", () => {
          touchStart = null;
        });
        map.on("touchend", (event) => {
          const start = touchStart;
          touchStart = null;
          if (
            !start ||
            event.points.length !== 1 ||
            Math.hypot(event.point.x - start.x, event.point.y - start.y) > 10
          ) {
            return;
          }
          if (activateMap(event.point)) suppressClickUntil = Date.now() + 700;
        });
        map.on(
          "mousemove",
          "field-point-hit-targets",
          (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
            const feature = event.features?.[0];
            const pointId = feature?.properties?.pointId;
            const address = feature?.properties?.address;
            if (typeof pointId !== "string" || typeof address !== "string") return;
            map.setFilter("field-point-hover", ["==", ["get", "pointId"], pointId]);
            setHoveredPoint({ address, x: event.point.x, y: event.point.y });
          },
        );
        map.on("mouseenter", "field-point-hit-targets", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "field-point-hit-targets", () => {
          map.getCanvas().style.cursor = "";
          map.setFilter("field-point-hover", ["==", ["get", "pointId"], ""]);
          setHoveredPoint(null);
        });
        map.on(
          "click",
          "field-segment-service-sides",
          (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
            const segmentId = event.features?.[0]?.properties?.segmentId;
            if (typeof segmentId === "string") setSelectedSegmentId(segmentId);
          },
        );
        map.on("mouseenter", "field-segment-service-sides", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "field-segment-service-sides", () => {
          map.getCanvas().style.cursor = "";
        });
        map.on("dragstart", stopFollowingLocation);
        map.on("zoomstart", (event) => {
          if (event.originalEvent) stopFollowingLocation();
        });
        map.on("rotatestart", (event) => {
          if (event.originalEvent) stopFollowingLocation();
        });
        const bounds = boundsRef.current;
        if (bounds) map.fitBounds(bounds, { padding: 36, duration: 0, maxZoom: 17 });
      });
      return () => {
        mapRef.current = null;
        map.remove();
      };
    } catch {
      setFallback(true);
    }
  }, [descriptionId, points.length, stopFollowingLocation]);

  useEffect(() => {
    const source = mapRef.current?.getSource("field-points") as GeoJSONSource | undefined;
    source?.setData(data);
  }, [data]);

  useEffect(() => {
    const source = mapRef.current?.getSource("field-segments") as GeoJSONSource | undefined;
    source?.setData(segmentData);
  }, [segmentData]);

  useEffect(() => {
    const source = mapRef.current?.getSource("field-parcels") as GeoJSONSource | undefined;
    source?.setData(parcelData);
  }, [parcelData]);

  useEffect(() => {
    const source = mapRef.current?.getSource("field-dwellings") as GeoJSONSource | undefined;
    source?.setData(dwellingData);
  }, [dwellingData]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("field-point-selection")) {
      map.setFilter("field-point-selection", ["==", ["get", "pointId"], selectedPointId ?? ""]);
    }
  }, [selectedPointId]);

  const locationStatusText = (() => {
    if (locationPhase === "requesting") return "Buscando una señal GPS precisa…";
    if (locationPhase === "error") return locationError;
    if (locationPhase === "tracking" && liveLocation) {
      const accuracy = formatLocationAccuracy(liveLocation.accuracy);
      return followingLocation
        ? `Siguiendo en tiempo real · ${accuracy}`
        : `Ubicación disponible · ${accuracy}. Toca el botón para volver a centrar.`;
    }
    return "";
  })();
  const locationButtonLabel =
    locationPhase === "requesting"
      ? "Buscando ubicación"
      : liveLocation
        ? "Centrar y seguir mi ubicación"
        : "Mostrar mi ubicación";

  return (
    <section
      className={`field-map${fullscreen ? " field-map--fullscreen" : ""}`}
      aria-labelledby={descriptionId}
      ref={mapSectionRef}
    >
      <p id={descriptionId} className="sr-only">
        Mapa operativo con {points.length.toLocaleString("es-CL")} viviendas visibles y{" "}
        {segments.length.toLocaleString("es-CL")} tramos. Hay{" "}
        {parcelData.features.length.toLocaleString("es-CL")} límites prediales y{" "}
        {dwellingData.features.length.toLocaleString("es-CL")} huellas de construcciones cargadas.
        Los colores y desplazamientos de cada tramo muestran el lado declarado respecto al sentido
        de sus coordenadas. Usa los buscadores para consultar puntos y tramos mediante teclado.
      </p>
      {fallback ? (
        <div className="map-fallback" role="status">
          El mapa acelerado no está disponible. La búsqueda y las acciones siguen operativas.
        </div>
      ) : (
        <div className="field-map__viewport">
          <div className="field-map__canvas" ref={mapContainerRef} />
          <fieldset className="field-map__controls">
            <legend className="sr-only">Controles del mapa</legend>
            <button
              aria-label={locationButtonLabel}
              aria-pressed={followingLocation}
              className="field-map__control"
              data-active={followingLocation || undefined}
              data-state={locationPhase}
              disabled={locationPhase === "requesting"}
              onClick={startOrCenterLocation}
              title={locationButtonLabel}
              type="button"
            >
              <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                <circle cx="12" cy="12" r="7" />
              </svg>
              <span>Mi ubicación</span>
            </button>
            <button
              aria-label={
                fullscreen ? "Salir de pantalla completa" : "Abrir mapa en pantalla completa"
              }
              aria-pressed={fullscreen}
              className="field-map__control field-map__control--fullscreen"
              data-active={fullscreen || undefined}
              onClick={() => void toggleFullscreen()}
              title={fullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
              type="button"
            >
              <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
                {fullscreen ? (
                  <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
                ) : (
                  <path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" />
                )}
              </svg>
              <span>{fullscreen ? "Salir" : "Pantalla completa"}</span>
            </button>
          </fieldset>
          <div className="field-map__count" role="status">
            <span>
              <strong>{points.length.toLocaleString("es-CL")}</strong> viviendas · toca una
            </span>
            <small>Las construcciones y predios aparecen al acercar</small>
          </div>
          {locationStatusText ? (
            <div
              className="field-map__location-status"
              data-state={locationPhase}
              role={
                locationPhase === "error"
                  ? "alert"
                  : locationPhase === "requesting"
                    ? "status"
                    : undefined
              }
            >
              <strong>{locationStatusText}</strong>
              <span>
                RutaCuadrilla no guarda ni envía tu GPS; el mapa solicita al proveedor las imágenes
                del sector visible.
              </span>
            </div>
          ) : null}
          {hoveredPoint && !selectedPoint ? (
            <div
              className="field-map__point-tooltip"
              role="tooltip"
              style={{ left: hoveredPoint.x, top: hoveredPoint.y }}
            >
              {hoveredPoint.address}
            </div>
          ) : null}
          {selectedPoint && onSetPointState && editingEnabled ? (
            <div className="field-map__panel-layer">
              <PointStatePanel
                className="map-point-panel"
                feedback={feedback?.pointId === selectedPoint.id ? feedback : null}
                online={online}
                onClose={() => clearSelectedPoint()}
                onSetState={onSetPointState}
                point={selectedPoint}
                savingState={savingPointId === selectedPoint.id ? savingState : null}
              />
            </div>
          ) : null}
        </div>
      )}
      <ul className="field-map__legend" aria-label="Leyenda de estados">
        {STATE_LEGEND.map((item) => (
          <li key={item.state}>
            <span
              aria-hidden="true"
              style={{
                backgroundColor: item.color,
                height: `${item.size + 5}px`,
                width: `${item.size + 5}px`,
              }}
            />
            {item.label}
          </li>
        ))}
      </ul>
      <section className="field-map__segments" aria-labelledby={`${descriptionId}-segments`}>
        <h2 id={`${descriptionId}-segments`}>Lado operativo por tramo</h2>
        <p>
          Izquierda y derecha siguen el sentido guardado del tramo, desde su primera coordenada
          hacia la última. La aplicación no asigna viviendas por cercanía.
        </p>
        <ul className="field-map__side-legend" aria-label="Leyenda de lados de calle">
          {SERVICE_SIDE_LEGEND.map((item) => (
            <li key={item.serviceSide}>
              <span aria-hidden="true" style={{ backgroundColor: item.color }} />
              {SERVICE_SIDE_LABELS[item.serviceSide]}
            </li>
          ))}
        </ul>
        {segments.length === 0 ? (
          <p role="status">Este contexto no incluye tramos con lado operativo informado.</p>
        ) : (
          <>
            <label htmlFor={`${descriptionId}-segment-search`}>Buscar tramo o lado asignado</label>
            <input
              id={`${descriptionId}-segment-search`}
              type="search"
              value={segmentQuery}
              onChange={(event) => setSegmentQuery(event.currentTarget.value)}
              placeholder="Ej.: Los Aromos o lado izquierdo"
            />
            <ul aria-label="Resultados de tramos">
              {segmentResults.map((segment) => (
                <li key={segment.id}>
                  <button
                    type="button"
                    className={segment.id === selectedSegmentId ? "selected" : ""}
                    aria-pressed={segment.id === selectedSegmentId}
                    onClick={() => focusSegment(segment)}
                  >
                    <span className="field-map__result-title">
                      {segment.name || "Tramo sin nombre"}
                    </span>
                    <strong className="field-map__result-side">
                      {formatFieldSegmentSide(segment)}
                    </strong>
                    <small className="field-map__result-meta">
                      Tramo {segment.displayOrder + 1} · {segment.externalId}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <div className="field-map__search">
        <label htmlFor="field-point-search">Buscar punto, calle o número</label>
        <input
          id="field-point-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Ej.: Los Aromos 120"
        />
        <ul aria-label="Resultados de puntos">
          {searchResults.map((point) => (
            <li key={point.id}>
              <button
                type="button"
                className={point.id === selectedPointId ? "selected" : ""}
                aria-pressed={point.id === selectedPointId}
                onClick={(event) => {
                  selectionFocusRef.current = event.currentTarget;
                  onSelect(point.id);
                }}
              >
                <span className="field-map__result-title">
                  {point.street || "Calle no informada"} {point.number || "S/N"}
                </span>
                <small className="field-map__result-meta">
                  {POINT_STATE_LABELS[point.state]} · {point.externalId}
                </small>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <footer className="field-map__attribution">
        <span>
          Mapa base:{" "}
          {import.meta.env.VITE_MAP_STYLE_URL
            ? "proveedor configurado"
            : "fondo neutro sin proveedor externo"}
        </span>
        {import.meta.env.VITE_MAP_STYLE_URL ? (
          <span>La atribución del proveedor configurado se muestra dentro del mapa.</span>
        ) : null}
        {import.meta.env.VITE_MAP_STYLE_URL &&
        segments.some((segment) => segment.source === "OSM") ? (
          <span>
            Datos de tramos:{" "}
            <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>
          </span>
        ) : null}
        {parcelData.features.length > 0 || dwellingData.features.length > 0 ? (
          <span>
            Geometrías de predios y construcciones:{" "}
            {catalogAttribution?.url ? (
              <a href={catalogAttribution.url}>{catalogAttribution.label}</a>
            ) : (
              catalogAttribution?.label || "catálogos configurados"
            )}
          </span>
        ) : null}
      </footer>
    </section>
  );
}
