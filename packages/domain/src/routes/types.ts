import type { PointSource, PointType, RevisionStatus } from "../constants.js";
import type { CsvPreview, CsvRowError } from "./csv.js";
import type {
  BoundingBox,
  MultiLineStringGeometry,
  MultiPolygonGeometry,
  PointGeometry,
} from "./geometry.js";

export type SegmentSource = "GEOJSON" | "MANUAL" | "OSM";

export const serviceSides = ["LEFT", "RIGHT", "BOTH"] as const;

/**
 * Side served by a route assignment for a street segment. LEFT and RIGHT are
 * relative to the stored coordinate order of each line, never to a compass
 * direction. For a side-specific MultiLineString, components must form one
 * end-to-start chain so their orientation is coherent; otherwise callers must
 * reorder, reverse or split the geometry. The assignment belongs to a revision,
 * not to the shared street identity or geometry version.
 */
export type ServiceSide = (typeof serviceSides)[number];

export type RoutePointView = {
  externalId: string;
  id: string;
  latitude: number;
  longitude: number;
  number?: string;
  pointType: PointType;
  servicePointVersionId: string;
  source: PointSource;
  street?: string;
};

export type RouteRevisionView = {
  area: MultiPolygonGeometry | null;
  contentHash?: string;
  contentSchemaVersion?: 2;
  createdAt: string;
  draftVersion: number;
  id: string;
  issues?: CsvRowError[];
  number: number | null;
  pointCount: number;
  points: RoutePointView[];
  publishedAt?: string;
  segmentCount: number;
  status: RevisionStatus;
};

export type RouteSummaryView = {
  id: string;
  latestRevision: Pick<
    RouteRevisionView,
    "id" | "number" | "status" | "pointCount" | "createdAt" | "publishedAt"
  >;
  name: string;
  sectorName: string;
  updatedAt: string;
};

export type RouteDetailView = {
  crewId: string;
  id: string;
  name: string;
  revisions: RouteRevisionView[];
  sectorName: string;
  updatedAt: string;
};

export type ImportRouteInput = {
  actorUserId: string;
  area?: unknown;
  crewId: string;
  csv: string;
  importKey: string;
  routeName: string;
  sectorName: string;
  segments?: Array<{
    attribution?: string | undefined;
    externalId: string;
    geometry: unknown;
    name?: string | undefined;
    serviceSide?: ServiceSide | undefined;
    source: SegmentSource;
    sourceVersion?: string | undefined;
  }>;
};

export type ImportRouteResult = {
  created: boolean;
  errors: CsvRowError[];
  revision: RouteRevisionView | null;
  route: RouteDetailView | null;
};

export type PublishRevisionInput = {
  actorUserId: string;
  crewId: string;
  revisionId: string;
  routeId: string;
};

export type CorrectDraftPointsInput = {
  actorUserId: string;
  crewId: string;
  csv: string;
  editKey: string;
  revisionId: string;
  routeId: string;
};

export type CorrectDraftPointsResult = {
  errors: CsvRowError[];
  replayed: boolean;
  revision: RouteRevisionView | null;
  route: RouteDetailView | null;
};

export type EditableRoutePoint = {
  externalId: string;
  latitude: number;
  longitude: number;
  number?: string;
  pointType: PointType;
  source: PointSource;
  street?: string;
};

export type EditableStreetSegment = {
  attribution?: string;
  externalId: string;
  geometry: MultiLineStringGeometry;
  name?: string;
  serviceSide: ServiceSide;
  source: SegmentSource;
  sourceVersion?: string;
};

export type RoutePointFeature = {
  geometry: PointGeometry;
  id: string;
  properties: {
    displayOrder: number;
    externalId: string;
    number?: string;
    pointType: PointType;
    servicePointVersionId: string;
    source: PointSource;
    street?: string;
  };
  type: "Feature";
};

export type RouteSegmentFeature = {
  geometry: MultiLineStringGeometry;
  id: string;
  properties: {
    attribution?: string;
    displayOrder: number;
    externalId: string;
    name?: string;
    serviceSide: ServiceSide;
    source: SegmentSource;
    sourceVersion?: string;
    streetSegmentVersionId: string;
  };
  type: "Feature";
};

export type FeatureCollection<Feature> = {
  features: Feature[];
  type: "FeatureCollection";
};

export type RouteRevisionFeatures = {
  area: MultiPolygonGeometry | null;
  bounds: BoundingBox | null;
  contentHash?: string;
  draftVersion: number;
  pointCount: number;
  points: FeatureCollection<RoutePointFeature>;
  revisionId: string;
  routeId: string;
  schemaVersion: 1;
  segmentCount: number;
  segments: FeatureCollection<RouteSegmentFeature>;
  status: RevisionStatus;
};

export type SetAreaChange = {
  geometry: MultiPolygonGeometry | null;
  type: "SET_AREA";
};

export type AddPointChange = {
  point: EditableRoutePoint;
  type: "ADD_POINT";
};

export type UpdatePointChange = {
  expectedServicePointVersionId?: string;
  point: Partial<Omit<EditableRoutePoint, "externalId" | "source">>;
  servicePointId: string;
  type: "UPDATE_POINT";
};

export type RemovePointChange = {
  servicePointId: string;
  type: "REMOVE_POINT";
};

export type ReplaceSegmentsChange = {
  segments: EditableStreetSegment[];
  type: "REPLACE_SEGMENTS";
};

export type ImportOsmSelectionChange = {
  points: EditableRoutePoint[];
  segments: EditableStreetSegment[];
  type: "IMPORT_OSM_SELECTION";
};

export type RouteRevisionChange =
  | AddPointChange
  | ImportOsmSelectionChange
  | RemovePointChange
  | ReplaceSegmentsChange
  | SetAreaChange
  | UpdatePointChange;

export type ApplyRouteRevisionChangeInput = {
  actorUserId: string;
  baseDraftVersion: number;
  change: RouteRevisionChange;
  crewId: string;
  operationId: string;
  revisionId: string;
  routeId: string;
};

export type ApplyRouteRevisionChangeResult = {
  draftVersion: number;
  pointCount: number;
  replayed: boolean;
  revisionId: string;
  routeId: string;
  segmentCount: number;
};

export type OsmCandidatePreview = {
  attribution: string;
  points: EditableRoutePoint[];
  segments: EditableStreetSegment[];
  summary: {
    candidatePoints: number;
    candidateSegments: number;
    sourceElements: number;
  };
  warnings: string[];
};

export type RoutePackageDto = {
  area: MultiPolygonGeometry | null;
  attributions: Array<{ label: string; url: string }>;
  bounds: { east: number; north: number; south: number; west: number };
  crewId: string;
  kind: "ROUTE_REVISION_PACKAGE";
  points: Array<{
    displayOrder: number;
    externalId: string;
    id: string;
    latitude: number;
    longitude: number;
    number?: string;
    pointType: PointType;
    servicePointVersionId: string;
    source: PointSource;
    street?: string;
  }>;
  revision: {
    contentHash: string;
    id: string;
    number: number;
    pointCount: number;
    publishedAt: string;
    status: Exclude<RevisionStatus, "DRAFT">;
  };
  route: { id: string; name: string; sectorName: string };
  schemaVersion: 1;
  segments: Array<{
    attribution?: string;
    displayOrder: number;
    externalId: string;
    geometry: MultiLineStringGeometry;
    id: string;
    name?: string;
    serviceSide: ServiceSide;
    source: SegmentSource;
    sourceVersion?: string;
    streetSegmentVersionId: string;
  }>;
};

export type RouteServiceApi = {
  applyRevisionChange(
    input: ApplyRouteRevisionChangeInput,
  ): Promise<ApplyRouteRevisionChangeResult>;
  correctDraftPoints(input: CorrectDraftPointsInput): Promise<CorrectDraftPointsResult>;
  getRoute(crewId: string, routeId: string): Promise<RouteDetailView | null>;
  getRoutePackage(crewId: string, routeId: string, revisionId: string): Promise<RoutePackageDto>;
  getRevisionFeatures(
    crewId: string,
    routeId: string,
    revisionId: string,
  ): Promise<RouteRevisionFeatures | null>;
  importRoute(input: ImportRouteInput): Promise<ImportRouteResult>;
  listRoutes(crewId: string): Promise<RouteSummaryView[]>;
  previewOsmExport(raw: unknown): OsmCandidatePreview;
  previewCsv(csv: string): CsvPreview;
  publishRevision(input: PublishRevisionInput): Promise<RouteDetailView>;
};
