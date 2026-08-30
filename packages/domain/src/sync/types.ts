import type { MultiLineStringGeometry } from "../routes/geometry.js";
import type { SegmentSource, ServiceSide } from "../routes/types.js";

export const syncContractVersion = "p0-provisional-v3" as const;

/**
 * These labels implement the currently documented P0 proposal. They are a
 * versioned technical contract, not evidence that BIZ-02 has been approved.
 */
export const provisionalPointStates = [
  "SIN_VISITAR",
  "SOBRE_ENTREGADO",
  "VOLVER",
  "SIN_RESPUESTA",
  "APORTO",
  "NO_PARTICIPA",
] as const;

export type ProvisionalPointState = (typeof provisionalPointStates)[number];

export type PointStatusChangedCommand = {
  baseVersion: number;
  campaignPointId: string;
  dependsOnOperationId?: string;
  deviceId: string;
  occurredAtDevice?: string;
  operationId: string;
  payload: { state: ProvisionalPointState };
  type: "POINT_STATUS_CHANGED";
  workSessionId: string;
};

export type PointStatusRevertedCommand = {
  baseVersion: number;
  campaignPointId: string;
  dependsOnOperationId?: string;
  deviceId: string;
  occurredAtDevice?: string;
  operationId: string;
  payload: { revertsOperationId: string };
  type: "POINT_STATUS_REVERTED";
  workSessionId: string;
};

export type SyncCommand = PointStatusChangedCommand | PointStatusRevertedCommand;

export type SyncCommandStatus = "APPLIED" | "BLOCKED_DEPENDENCY" | "CONFLICT" | "REJECTED";

export type SyncCommandResult = {
  campaignPointId: string;
  changeSequence?: number;
  code?: string;
  eventId?: string;
  operationId: string;
  replayed: boolean;
  state?: ProvisionalPointState;
  status: SyncCommandStatus;
  version?: number;
  workSessionId: string;
};

export type PushCommandsInput = {
  actorUserId: string;
  commands: SyncCommand[];
  crewId: string;
};

export type PushCommandsResult = {
  contractVersion: typeof syncContractVersion;
  results: SyncCommandResult[];
};

export type SyncChange = {
  campaignPointId: string;
  eventId: string;
  operationId: string;
  revertsEventId?: string;
  sequence: number;
  state: ProvisionalPointState;
  type: "POINT_STATUS_CHANGED" | "POINT_STATUS_REVERTED";
  version: number;
  /** Missing only on change-log rows created before migration 009. */
  workSessionId?: string;
};

export type PullChangesInput = {
  actorUserId: string;
  crewId: string;
  cursor?: string;
  limit?: number;
};

export type PullChangesResult = {
  changes: SyncChange[];
  contractVersion: typeof syncContractVersion;
  cursor: string;
  hasMore: boolean;
};

export type TechnicalContextSummary = {
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
};

export type TechnicalContextPoint = {
  displayOrder: number;
  displayState: ProvisionalPointState;
  externalId: string;
  id: string;
  latitude: number;
  longitude: number;
  number?: string;
  pointType: "BUILDING_ENTRANCE" | "COMPLEX_ACCESS" | "DWELLING" | "SPECIAL";
  servicePointId: string;
  servicePointVersionId: string;
  street?: string;
  version: number;
};

export type TechnicalContextSegment = {
  attribution?: string;
  displayOrder: number;
  externalId: string;
  geometry: MultiLineStringGeometry;
  id: string;
  name?: string;
  /** LEFT/RIGHT is relative to this geometry's coordinate order, never north/south. */
  serviceSide: ServiceSide;
  source: SegmentSource;
  sourceVersion?: string;
  streetSegmentVersionId: string;
};

export type TechnicalContextPackage = {
  context: TechnicalContextSummary;
  contractVersion: typeof syncContractVersion;
  points: TechnicalContextPoint[];
  segments: TechnicalContextSegment[];
};

export type CreateTechnicalContextInput = {
  actorUserId: string;
  campaignName?: string;
  crewId: string;
  routeRevisionId: string;
};

export type ContextAccessInput = {
  actorUserId: string;
  crewId: string;
};

export type GetContextPackageInput = ContextAccessInput & { contextId: string };

export type SyncServiceApi = {
  createTechnicalContext(input: CreateTechnicalContextInput): Promise<TechnicalContextPackage>;
  getContextPackage(input: GetContextPackageInput): Promise<TechnicalContextPackage | null>;
  listContexts(input: ContextAccessInput): Promise<TechnicalContextSummary[]>;
  pullChanges(input: PullChangesInput): Promise<PullChangesResult>;
  pushCommands(input: PushCommandsInput): Promise<PushCommandsResult>;
};
