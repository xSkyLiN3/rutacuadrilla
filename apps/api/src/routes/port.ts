import type { RouteDetailView, RouteServiceApi, RouteSummaryView } from "@rutacuadrilla/domain";

export type { RouteDetailView, RouteSummaryView };

export type RouteServicePort = Pick<
  RouteServiceApi,
  | "applyRevisionChange"
  | "correctDraftPoints"
  | "getRevisionFeatures"
  | "getRoute"
  | "getRoutePackage"
  | "importRoute"
  | "listRoutes"
  | "previewOsmExport"
  | "publishRevision"
>;
