import type {
  ConflictResolutionDecision,
  ConflictResolutionResult,
  FieldContextPackage,
  FieldPoint,
  LocalContextSummary,
  LocalOperation,
  LocalWorkSession,
  PointState,
  SyncChange,
  SyncOperationResult,
} from "../types";

export type H40DeviceAlias = "A" | "B";
export type H40ActionKind = "MARK" | "UNDO";
export type H40MetricEventKind =
  | "OFFLINE_START"
  | "OFFLINE_END"
  | "BOOT"
  | "SYNC_START"
  | "SYNC_END"
  | "RECOVERY";
export type H40RunStatus = "RUNNING" | "FINISHED" | "ABORTED";
export type H40FinishBlockCode =
  | "LESS_THAN_30_ACTIONS"
  | "INCOMPLETE_ACTION_METRICS"
  | "OUTBOX_NOT_EMPTY"
  | "ATTENTION_REQUIRED";

export interface H40LatencySummary {
  count: number;
  max: number | null;
  p50: number | null;
  p95: number | null;
}

/** Internal UI summary: excludes identity, context and operation identifiers. */
export interface H40RunSummary {
  actionCount: number;
  buildId: string;
  completedActionCount: number;
  deviceAlias: H40DeviceAlias;
  endedAt?: string;
  lastMetricSequence: number;
  markCount: number;
  metricCount: number;
  persistMs: H40LatencySummary;
  runId: string;
  startedAt: string;
  status: H40RunStatus;
  undoCount: number;
  visualMs: H40LatencySummary;
}

export interface H40MetricRecord {
  applied?: number;
  conflict?: number;
  errorCode?: string;
  eventKind: H40MetricEventKind;
  monotonicMs?: number;
  pending?: number;
  recordedSequence: number;
  rejected?: number;
  replayed?: number;
  wallAt: string;
}

/**
 * Internal-only source for hashing operation ids before export. It is not an export DTO and
 * intentionally still excludes account, crew, route/session and work-session identifiers.
 */
export interface H40EvidenceSource {
  finalOutbox: {
    conflict: number;
    pending: number;
    rejected: number;
    sending: number;
  };
  metrics: H40MetricRecord[];
  operations: Array<{
    actionKind: H40ActionKind;
    operationId: string;
    persistMs?: number;
    recordedAt: string;
    visualMs?: number;
  }>;
  projection: Array<{
    id: string;
    state: PointState;
    version: number;
  }>;
  recoveredSending: number;
  salt: string;
  summary: H40RunSummary;
}

export interface H40FinishResult {
  blocking: Array<{
    code: H40FinishBlockCode;
    current: number;
    required: number;
  }>;
  finished: boolean;
  summary: H40RunSummary;
}

export interface H40ContextKey {
  accountId: string;
  crewId: string;
  sessionId: string;
  workSessionId: string;
}

export interface H40MetricInput extends H40ContextKey {
  applied?: number;
  conflict?: number;
  errorCode?: string;
  eventKind: H40MetricEventKind;
  monotonicMs?: number;
  pending?: number;
  rejected?: number;
  replayed?: number;
  runId: string;
  wallAt: string;
}

export type LocalDatabaseRequest =
  | { id: number; type: "init" }
  | {
      id: number;
      type: "bind-account";
      legacyAccountId: string;
      partitionId: string;
      subjectBinding: string;
    }
  | { id: number; type: "clear-account"; accountId: string }
  | { id: number; type: "install-package"; accountId: string; package: FieldContextPackage }
  | {
      id: number;
      type: "save-work-session";
      accountId: string;
      campaignRouteId: string;
      crewId: string;
      deviceId: string;
      membershipId: string;
      session: LocalWorkSession;
    }
  | {
      id: number;
      type: "get-outbox-status";
      accountId: string;
      crewId: string;
      sessionId: string;
    }
  | { id: number; type: "get-context"; accountId: string; crewId: string; sessionId: string }
  | { id: number; type: "list-points"; accountId: string; crewId: string; sessionId: string }
  | {
      id: number;
      type: "mark-point";
      accountId: string;
      crewId: string;
      deviceId: string;
      membershipId: string;
      pointId: string;
      sessionId: string;
      toState: PointState;
      workSessionId: string;
      h40RunId?: string;
    }
  | {
      id: number;
      type: "undo-operation";
      accountId: string;
      crewId: string;
      deviceId: string;
      membershipId: string;
      operationId: string;
      sessionId: string;
      workSessionId: string;
      h40RunId?: string;
    }
  | {
      id: number;
      type: "start-h40-run";
      accountId: string;
      buildId: string;
      crewId: string;
      deviceAlias: H40DeviceAlias;
      deviceId: string;
      membershipId: string;
      salt: string;
      sessionId: string;
      workSessionId: string;
    }
  | ({ id: number; type: "get-running-h40-run" } & H40ContextKey)
  | ({ id: number; type: "get-latest-h40-run" } & H40ContextKey)
  | ({ id: number; type: "get-h40-run-summary"; runId: string } & H40ContextKey)
  | ({ id: number; type: "get-h40-evidence-source"; runId: string } & H40ContextKey)
  | ({ id: number; type: "mark-h40-run-exported"; runId: string } & H40ContextKey)
  | ({
      id: number;
      type: "complete-h40-action";
      operationId: string;
      persistMs: number;
      runId: string;
      visualMs: number;
    } & H40ContextKey)
  | ({ id: number; type: "record-h40-metric" } & H40MetricInput)
  | ({ id: number; type: "finish-h40-run"; runId: string } & H40ContextKey)
  | ({ id: number; type: "abort-h40-run"; runId: string } & H40ContextKey)
  | { id: number; type: "list-history"; accountId: string; crewId: string; sessionId: string }
  | { id: number; type: "list-pending"; accountId: string; crewId: string; sessionId: string }
  | {
      id: number;
      type: "mark-sending" | "restore-pending";
      accountId: string;
      crewId: string;
      sessionId: string;
      operationIds: string[];
    }
  | { id: number; type: "get-cursor"; accountId: string; crewId: string; sessionId: string }
  | {
      id: number;
      type: "apply-results";
      accountId: string;
      crewId: string;
      sessionId: string;
      results: SyncOperationResult[];
    }
  | {
      id: number;
      type: "apply-changes";
      accountId: string;
      crewId: string;
      sessionId: string;
      cursor: string;
      changes: SyncChange[];
    }
  | {
      id: number;
      type: "resolve-conflict";
      accountId: string;
      crewId: string;
      decision: ConflictResolutionDecision;
      deviceId: string;
      membershipId: string;
      operationId: string;
      reason: string;
      sessionId: string;
      workSessionId: string;
      h40RunId?: string;
    };

export interface LocalDatabaseInfo {
  persistent: boolean;
  recovery: { integrity: "ok"; requeuedSending: number };
  schemaVersion: number;
}

export type LocalDatabaseResult =
  | LocalDatabaseInfo
  | FieldPoint[]
  | LocalContextSummary
  | LocalOperation
  | LocalOperation[]
  | ConflictResolutionResult
  | H40RunSummary
  | H40RunSummary[]
  | H40EvidenceSource
  | H40FinishResult
  | H40MetricRecord
  | null
  | { applied: number }
  | { bound: true; migratedContexts: number; migratedOperations: number }
  | { cleared: true }
  | { cursor: string }
  | { installed: true; pointCount: number }
  | {
      legacyBlocked: number;
      saved: true;
    }
  | { legacyBlocked: number; unresolved: number };

export type LocalDatabaseResponse =
  | { id: number; ok: true; result: LocalDatabaseResult }
  | { id: number; ok: false; error: string };
