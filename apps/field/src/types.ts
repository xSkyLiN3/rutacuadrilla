export type PointState =
  | "APORTO"
  | "NO_PARTICIPA"
  | "SIN_RESPUESTA"
  | "SIN_VISITAR"
  | "SOBRE_ENTREGADO"
  | "VOLVER";
export type ServiceSide = "BOTH" | "LEFT" | "RIGHT";
export type OutboxState =
  | "CONFIRMED"
  | "CONFLICT"
  | "PENDING"
  | "REJECTED"
  | "SENDING"
  | "SUPERSEDED";
export type ConflictResolutionDecision = "ACCEPT_SERVER" | "REAPPLY_LOCAL";
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

export interface LocalWorkSession {
  campaignId: string;
  campaignRouteId: string;
  devices: WorkSessionDevice[];
  finishedAt?: string;
  finishedByMembershipId?: string;
  id: string;
  participants: WorkSessionParticipant[];
  startedAt: string;
  startedByDeviceId: string;
  startedByMembershipId: string;
  status: WorkSessionStatus;
  version: number;
}

export interface FieldPoint {
  displayOrder: number;
  externalId: string;
  id: string;
  latitude: number;
  longitude: number;
  number?: string;
  pointType: string;
  state: PointState;
  street?: string;
  version: number;
}

export interface FieldSegment {
  attribution?: string;
  displayOrder: number;
  externalId: string;
  geometry: {
    coordinates: Array<Array<[number, number]>>;
    type: "MultiLineString";
  };
  id: string;
  name?: string;
  serviceSide: ServiceSide;
  source: "GEOJSON" | "MANUAL" | "OSM";
  sourceVersion?: string;
  streetSegmentVersionId: string;
}

export interface FieldContextPackage {
  campaignId: string;
  campaignRouteId: string;
  contentHash: string;
  crewId: string;
  points: FieldPoint[];
  routeId: string;
  routeName: string;
  routeRevisionId: string;
  rawBody: string;
  schemaVersion: 1;
  segments: FieldSegment[];
  sessionId: string;
  transportSha256: string;
  vehicleId?: string;
  vehicleName?: string;
}

export interface FieldContextSummary {
  campaignId: string;
  campaignName: string;
  contentHash: string;
  id: string;
  pointCount: number;
  routeId: string;
  routeName: string;
  routeRevisionId: string;
  segmentCount: number;
  vehicleId?: string;
  vehicleName?: string;
}

export interface LocalContextSummary {
  campaignId: string;
  campaignRouteId: string;
  contentHash: string;
  crewId: string;
  pointCount: number;
  routeName: string;
  routeRevisionId: string;
  segmentCount: number;
  segments: FieldSegment[];
  sessionId: string;
  workSession?: LocalWorkSession;
  vehicleId?: string;
  vehicleName?: string;
}

export interface LocalOperation {
  accountId: string;
  aggregateId: string;
  baseVersion: number;
  crewId: string;
  canonicalState?: PointState;
  canonicalVersion?: number;
  conflictCode?: string;
  dependsOnOperationId?: string;
  deviceId: string;
  deviceSequence: number;
  operationId: string;
  previousState: PointState;
  resolutionDecision?: ConflictResolutionDecision;
  resolutionConverged?: boolean;
  resolutionOperationId?: string;
  resolutionOperationState?: OutboxState;
  resolutionReason?: string;
  resolvesOperationId?: string;
  state: OutboxState;
  toState: PointState;
  undoesOperationId?: string;
  workSessionId?: string;
}

export interface ConflictResolutionResult {
  decision: ConflictResolutionDecision;
  operation?: LocalOperation;
  resolutionId: string;
}

export interface SyncOperationResult {
  canonicalState?: PointState;
  canonicalVersion?: number;
  code?: string;
  operationId: string;
  replayed?: boolean;
  state?: PointState;
  status: "APPLIED" | "BLOCKED_DEPENDENCY" | "CONFLICT" | "REJECTED";
  version?: number;
  workSessionId: string;
}

export interface SyncChange {
  pointId: string;
  sequence: number;
  state: PointState;
  version: number;
  workSessionId?: string;
}

export interface FieldUser {
  email: string;
  id: string;
  name: string;
}

export interface FieldMembership {
  crewId: string;
  crewName: string;
  membershipId: string;
  role: "ADMIN" | "MEMBER";
}
