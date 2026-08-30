import type { RoutePackageDownloadResult } from "./routePackageClient";

export type MembershipRole = "ADMIN" | "MEMBER";
export type Capability =
  | "ROUTE_VIEW"
  | "ROUTE_DRAFT_EDIT"
  | "ROUTE_PUBLISH"
  | "CAMPAIGN_MANAGE"
  | "DENOMINATOR_AMEND"
  | "SESSION_START"
  | "SESSION_JOIN"
  | "POINT_MARK"
  | "POINT_CORRECT"
  | "POINT_CONFLICT_RESOLVE"
  | "GPS_TRACK"
  | "SESSION_CLOSE"
  | "SESSION_CLOSE_EXCEPTION"
  | "FINANCE_VIEW_OWN"
  | "FINANCE_VIEW_ALL"
  | "CLOSURE_CORRECT"
  | "MEMBERS_MANAGE";
export type RevisionStatus = "DRAFT" | "PUBLISHED" | "SUPERSEDED" | "ARCHIVED";
export type PointType = "DWELLING" | "BUILDING_ENTRANCE" | "COMPLEX_ACCESS" | "SPECIAL";
export type PointSource = "MANUAL" | "CSV" | "OSM" | "GEOJSON";
export type ServiceSide = "LEFT" | "RIGHT" | "BOTH";
export type CanonicalCsvColumn =
  | "external_id"
  | "street"
  | "number"
  | "latitude"
  | "longitude"
  | "point_type"
  | "source";

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Membership {
  capabilities?: Capability[];
  crewId: string;
  crewName: string;
  role: MembershipRole;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: User;
  memberships: Membership[];
}

export interface MeResponse {
  user: User;
  memberships: Membership[];
}

export interface RoutePoint {
  id: string;
  externalId: string;
  servicePointVersionId: string;
  street?: string;
  number?: string;
  latitude: number;
  longitude: number;
  pointType: PointType;
  source: PointSource;
}

export interface ImportIssue {
  row: number;
  code?: string;
  field?: CanonicalCsvColumn | "header" | "row";
  message: string;
  value?: string;
}

export interface RouteRevision {
  area?: MultiPolygonGeometry | null;
  draftVersion?: number;
  id: string;
  number: number | null;
  status: RevisionStatus;
  contentHash?: string;
  pointCount: number;
  segmentCount?: number;
  createdAt: string;
  publishedAt?: string;
  points: RoutePoint[];
  issues?: ImportIssue[];
}

export type Position = [longitude: number, latitude: number];
export type PolygonGeometry = { type: "Polygon"; coordinates: Position[][] };
export type MultiPolygonGeometry = { type: "MultiPolygon"; coordinates: Position[][][] };
export type LineGeometry =
  | { type: "LineString"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] };

export interface RevisionFeaturePoint extends RoutePoint {
  displayOrder: number;
}

export interface RevisionStreetSegment {
  attribution?: string;
  displayOrder: number;
  externalId: string;
  geometry: { type: "MultiLineString"; coordinates: Position[][] };
  id: string;
  name?: string;
  serviceSide: ServiceSide;
  source: "MANUAL" | "OSM" | "GEOJSON";
  sourceVersion?: string;
  streetSegmentVersionId: string;
}

export interface RevisionFeatures {
  area: MultiPolygonGeometry | null;
  bounds: [number, number, number, number] | null;
  contentHash?: string;
  draftVersion: number;
  pointCount: number;
  points: RevisionFeaturePoint[];
  revisionId: string;
  routeId: string;
  schemaVersion: 1;
  segmentCount: number;
  segments: RevisionStreetSegment[];
  status: RevisionStatus;
}

export type DraftMapPointInput = {
  externalId: string;
  latitude: number;
  longitude: number;
  number?: string;
  pointType: PointType;
  source: PointSource;
  street?: string;
};

export type DraftRevisionChange =
  | { type: "SET_AREA"; geometry: PolygonGeometry | MultiPolygonGeometry | null }
  | { type: "ADD_POINT"; point: DraftMapPointInput }
  | {
      type: "UPDATE_POINT";
      expectedServicePointVersionId?: string;
      point: Partial<Omit<DraftMapPointInput, "externalId" | "source">>;
      servicePointId: string;
    }
  | { type: "REMOVE_POINT"; servicePointId: string }
  | {
      type: "REPLACE_SEGMENTS";
      segments: Array<{
        attribution?: string;
        externalId: string;
        geometry: LineGeometry;
        name?: string;
        serviceSide: ServiceSide;
        source: "MANUAL" | "OSM" | "GEOJSON";
        sourceVersion?: string;
      }>;
    }
  | {
      type: "IMPORT_OSM_SELECTION";
      points: DraftMapPointInput[];
      segments: Array<{
        attribution?: string;
        externalId: string;
        geometry: LineGeometry;
        name?: string;
        serviceSide: ServiceSide;
        source: "OSM";
        sourceVersion?: string;
      }>;
    };

export interface DraftChangeResult {
  draftVersion: number;
  pointCount: number;
  replayed: boolean;
  revisionId: string;
  routeId: string;
  segmentCount: number;
}

export interface OsmPreview {
  attribution: string;
  points: DraftMapPointInput[];
  segments: Array<{
    attribution?: string;
    externalId: string;
    geometry: LineGeometry;
    name?: string;
    serviceSide: ServiceSide;
    source: "OSM";
    sourceVersion?: string;
  }>;
  summary: { candidatePoints: number; candidateSegments: number; sourceElements: number };
  warnings: string[];
}

export interface TechnicalContextPackage {
  context: {
    campaignId: string;
    campaignName: string;
    contentHash: string;
    id: string;
    pointCount: number;
    routeId: string;
    routeName: string;
    routeRevisionId: string;
    segmentCount: number;
  };
  contractVersion: "p0-provisional-v3";
  points: Array<{
    displayOrder: number;
    displayState:
      | "SIN_VISITAR"
      | "SOBRE_ENTREGADO"
      | "VOLVER"
      | "SIN_RESPUESTA"
      | "APORTO"
      | "NO_PARTICIPA";
    externalId: string;
    id: string;
    latitude: number;
    longitude: number;
    number?: string;
    pointType: PointType;
    servicePointId: string;
    servicePointVersionId: string;
    street?: string;
    version: number;
  }>;
  segments: RevisionStreetSegment[];
}

export interface RouteSummary {
  id: string;
  name: string;
  sectorName: string;
  latestRevision: Pick<
    RouteRevision,
    "id" | "number" | "status" | "contentHash" | "pointCount" | "createdAt" | "publishedAt"
  >;
  updatedAt: string;
}

export interface RouteDetail {
  id: string;
  crewId: string;
  name: string;
  sectorName: string;
  revisions: RouteRevision[];
  updatedAt: string;
}

export type CampaignStatus = "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED";
export type VehicleStatus = "ACTIVE" | "ARCHIVED";

export interface Vehicle {
  createdAt: string;
  id: string;
  name: string;
  registration?: string;
  status: VehicleStatus;
}

export interface CampaignRouteAssignment {
  createdAt: string;
  id: string;
  pointCount: number;
  routeContentHash: string;
  routeId: string;
  routeName: string;
  routeRevisionId: string;
  segmentSideClaimCount: number;
  status: "ACTIVE" | "ARCHIVED" | "CLOSED";
  vehicle: Vehicle;
}

export interface CampaignSummary {
  createdAt: string;
  currency: string;
  endsOn?: string;
  id: string;
  name: string;
  pointCount: number;
  routeCount: number;
  startsOn?: string;
  status: CampaignStatus;
  timezone: string;
  updatedAt: string;
}

export interface CampaignDetail extends CampaignSummary {
  routes: CampaignRouteAssignment[];
}

export type WorkSessionStatus = "ACTIVE" | "FINISHED";

export interface WorkSessionParticipant {
  displayName: string;
  joinedAt: string;
  membershipId: string;
  profile: "ASSISTANT" | "DRIVER" | "OTHER";
}

export interface WorkSessionDevice {
  deviceId: string;
  joinedAt: string;
  membershipId: string;
}

export interface WorkSession {
  campaignId: string;
  campaignRouteId: string;
  devices: WorkSessionDevice[];
  finishedAt?: string;
  id: string;
  participants: WorkSessionParticipant[];
  startedAt: string;
  startedByDeviceId: string;
  startedByMembershipId: string;
  status: WorkSessionStatus;
  version: number;
  finishedByMembershipId?: string;
}

export interface CurrentWorkSessionResponse {
  workSession: WorkSession | null;
}

export interface CreateVehicleRequest {
  name: string;
  registration?: string;
}

export interface CreateCampaignRequest {
  currency?: string;
  endsOn?: string;
  name: string;
  startsOn?: string;
  timezone?: string;
}

export interface AssignCampaignRouteResponse {
  assignment: CampaignRouteAssignment;
  created: boolean;
}

export interface ImportRouteRequest {
  routeName: string;
  sectorName: string;
  importKey: string;
  csv: string;
}

export interface ImportRouteResponse {
  route: RouteDetail;
  revision: RouteRevision;
  errors?: ImportIssue[];
}

export interface EditRevisionPointsRequest {
  editKey: string;
  csv: string;
}

export interface EditRevisionPointsResponse {
  route: RouteDetail;
  revision: RouteRevision;
  errors?: ImportIssue[];
}

export interface AdminApi {
  setToken(token: string | null): void;
  login(email: string, password: string): Promise<LoginResponse>;
  me(): Promise<MeResponse>;
  logout(): Promise<void>;
  listRoutes(crewId: string): Promise<RouteSummary[]>;
  getRoute(crewId: string, routeId: string): Promise<RouteDetail>;
  importRoute(crewId: string, input: ImportRouteRequest): Promise<ImportRouteResponse>;
  editRevisionPoints(
    crewId: string,
    routeId: string,
    revisionId: string,
    input: EditRevisionPointsRequest,
  ): Promise<EditRevisionPointsResponse>;
  publishRevision(crewId: string, routeId: string, revisionId: string): Promise<RouteDetail>;
  getRevisionFeatures(
    crewId: string,
    routeId: string,
    revisionId: string,
  ): Promise<RevisionFeatures>;
  applyDraftChange(
    crewId: string,
    routeId: string,
    revisionId: string,
    input: { operationId: string; baseDraftVersion: number; change: DraftRevisionChange },
  ): Promise<DraftChangeResult>;
  previewOsmExport(
    crewId: string,
    routeId: string,
    revisionId: string,
    exportPayload: unknown,
  ): Promise<OsmPreview>;
  createTechnicalContext(
    crewId: string,
    routeRevisionId: string,
    campaignName?: string,
  ): Promise<TechnicalContextPackage>;
  listVehicles(crewId: string): Promise<Vehicle[]>;
  createVehicle(crewId: string, input: CreateVehicleRequest): Promise<Vehicle>;
  listCampaigns(crewId: string): Promise<CampaignSummary[]>;
  getCampaign(crewId: string, campaignId: string): Promise<CampaignDetail>;
  createCampaign(crewId: string, input: CreateCampaignRequest): Promise<CampaignDetail>;
  assignCampaignRoute(
    crewId: string,
    campaignId: string,
    input: { routeRevisionId: string; vehicleId: string },
  ): Promise<AssignCampaignRouteResponse>;
  removeCampaignRoute(
    crewId: string,
    campaignId: string,
    campaignRouteId: string,
  ): Promise<CampaignDetail>;
  activateCampaign(crewId: string, campaignId: string): Promise<CampaignDetail>;
  getCurrentWorkSession?(
    crewId: string,
    campaignRouteId: string,
  ): Promise<CurrentWorkSessionResponse>;
  downloadRoutePackage?(
    crewId: string,
    routeId: string,
    revisionId: string,
    etag?: string,
  ): Promise<RoutePackageDownloadResult>;
}

export type SimplePointState =
  | "SIN_VISITAR"
  | "SOBRE_ENTREGADO"
  | "VOLVER"
  | "SIN_RESPUESTA"
  | "APORTO"
  | "NO_PARTICIPA";

export interface SimpleUser {
  assignment?: {
    id: string;
    routeId: string;
    routeName: string;
    routeRevisionId: string;
  };
  email: string;
  id: string;
  name: string;
  status: string;
}

export interface SimpleRoute {
  assignedUser?: { id: string; name: string };
  id: string;
  name: string;
  pointCount: number;
  publishedRevisionId: string | null;
  sectorName: string;
  updatedAt: string;
}

export interface SimpleProgress {
  assignmentId: string;
  routeId: string;
  routeName: string;
  states: Record<SimplePointState, number>;
  total: number;
  updatedAt: string;
  user: { id: string; name: string };
  visited: number;
}

export interface SimpleOverview {
  progress: SimpleProgress[];
  routes: SimpleRoute[];
  users: SimpleUser[];
}

export interface SimpleRouteImportRequest {
  area?: PolygonGeometry | MultiPolygonGeometry | null;
  csv: string;
  operationId: string;
  routeName: string;
  sectorName: string;
  segments?: Array<{
    attribution?: string;
    externalId: string;
    geometry: LineGeometry;
    name?: string;
    serviceSide?: ServiceSide;
    source: "GEOJSON" | "MANUAL" | "OSM";
    sourceVersion?: string;
  }>;
}

export interface SimpleAdminApi {
  setToken(token: string | null): void;
  login(email: string, password: string): Promise<LoginResponse>;
  me(): Promise<MeResponse>;
  logout(): Promise<void>;
  getSimpleOverview(crewId: string): Promise<SimpleOverview>;
  createSimpleUser(
    crewId: string,
    input: { displayName: string; email: string; password: string },
  ): Promise<SimpleUser>;
  assignSimpleRoute(crewId: string, userId: string, routeId: string): Promise<void>;
  unassignSimpleRoute(crewId: string, userId: string): Promise<void>;
  importSimpleRoute(
    crewId: string,
    input: SimpleRouteImportRequest,
  ): Promise<{ route: RouteDetail }>;
}
