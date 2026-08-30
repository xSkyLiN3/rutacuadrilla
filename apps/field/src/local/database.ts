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
import type {
  H40ContextKey,
  H40DeviceAlias,
  H40EvidenceSource,
  H40FinishResult,
  H40MetricInput,
  H40MetricRecord,
  H40RunSummary,
  LocalDatabaseInfo,
  LocalDatabaseRequest,
  LocalDatabaseResponse,
  LocalDatabaseResult,
} from "./protocol";

type RequestWithoutId = LocalDatabaseRequest extends infer T
  ? T extends { id: number }
    ? Omit<T, "id">
    : never
  : never;

export const LOCAL_DATABASE_REQUEST_TIMEOUT_MS = 15_000;
const LOCAL_DATABASE_TIMEOUT_ERROR =
  "LOCAL_DATABASE_WORKER_TIMEOUT: el almacenamiento local no respondió. Cierra otras pestañas de Campo y recarga; OPFS y la outbox no se borraron.";
const LOCAL_DATABASE_MESSAGE_ERROR =
  "LOCAL_DATABASE_WORKER_MESSAGE_ERROR: el worker local devolvió un mensaje ilegible. Recarga Campo; OPFS y la outbox no se borraron.";

interface FieldLocalDatabaseOptions {
  requestTimeoutMs?: number;
  worker?: Worker;
}

export class FieldLocalDatabase {
  private readonly worker: Worker;
  private readonly requestTimeoutMs: number;
  private closed = false;
  private sequence = 0;
  private readonly pending = new Map<
    number,
    {
      reject(error: Error): void;
      resolve(value: LocalDatabaseResult): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(options: FieldLocalDatabaseOptions = {}) {
    this.worker =
      options.worker ??
      new Worker(new URL("./sqlite.worker.ts", import.meta.url), { type: "module" });
    this.requestTimeoutMs = Math.max(
      1,
      options.requestTimeoutMs ?? LOCAL_DATABASE_REQUEST_TIMEOUT_MS,
    );
    this.worker.addEventListener("message", (event: MessageEvent<LocalDatabaseResponse>) => {
      const waiting = this.pending.get(event.data.id);
      if (!waiting) return;
      this.pending.delete(event.data.id);
      clearTimeout(waiting.timeout);
      if (event.data.ok) waiting.resolve(event.data.result);
      else waiting.reject(new Error(event.data.error));
    });
    this.worker.addEventListener("error", () => {
      this.failPending(
        "LOCAL_DATABASE_WORKER_FAILED: el almacenamiento local se detuvo. Recarga Campo; OPFS y la outbox no se borraron.",
      );
    });
    this.worker.addEventListener("messageerror", () => {
      this.failPending(LOCAL_DATABASE_MESSAGE_ERROR);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending("LOCAL_DATABASE_CLOSED");
    this.worker.terminate();
  }

  init(): Promise<LocalDatabaseInfo> {
    return this.request({ type: "init" }) as Promise<LocalDatabaseInfo>;
  }

  bindAccount(legacyAccountId: string, partitionId: string, subjectBinding: string) {
    return this.request({
      type: "bind-account",
      legacyAccountId,
      partitionId,
      subjectBinding,
    }) as Promise<{ bound: true; migratedContexts: number; migratedOperations: number }>;
  }

  clearAccount(accountId: string) {
    return this.request({ type: "clear-account", accountId });
  }

  installPackage(accountId: string, fieldPackage: FieldContextPackage) {
    return this.request({ type: "install-package", accountId, package: fieldPackage });
  }

  saveWorkSession(input: {
    accountId: string;
    campaignRouteId: string;
    crewId: string;
    deviceId: string;
    membershipId: string;
    session: LocalWorkSession;
  }) {
    return this.request({ type: "save-work-session", ...input }) as Promise<{
      legacyBlocked: number;
      saved: true;
    }>;
  }

  getOutboxStatus(accountId: string, crewId: string, sessionId: string) {
    return this.request({ type: "get-outbox-status", accountId, crewId, sessionId }) as Promise<{
      legacyBlocked: number;
      unresolved: number;
    }>;
  }

  getContext(accountId: string, crewId: string, sessionId: string) {
    return this.request({
      type: "get-context",
      accountId,
      crewId,
      sessionId,
    }) as Promise<LocalContextSummary>;
  }

  listPoints(accountId: string, crewId: string, sessionId: string) {
    return this.request({ type: "list-points", accountId, crewId, sessionId }) as Promise<
      FieldPoint[]
    >;
  }

  markPoint(input: {
    accountId: string;
    crewId: string;
    deviceId: string;
    membershipId: string;
    pointId: string;
    sessionId: string;
    toState: PointState;
    workSessionId: string;
    h40RunId?: string;
  }) {
    return this.request({ type: "mark-point", ...input }) as Promise<LocalOperation>;
  }

  undoOperation(input: {
    accountId: string;
    crewId: string;
    deviceId: string;
    membershipId: string;
    operationId: string;
    sessionId: string;
    workSessionId: string;
    h40RunId?: string;
  }) {
    return this.request({ type: "undo-operation", ...input }) as Promise<LocalOperation>;
  }

  startH40Run(
    input: H40ContextKey & {
      buildId: string;
      deviceAlias: H40DeviceAlias;
      deviceId: string;
      membershipId: string;
      salt: string;
    },
  ) {
    return this.request({ type: "start-h40-run", ...input }) as Promise<H40RunSummary>;
  }

  getRunningH40Run(input: H40ContextKey) {
    return this.request({ type: "get-running-h40-run", ...input }) as Promise<H40RunSummary | null>;
  }

  getLatestH40Run(input: H40ContextKey) {
    return this.request({ type: "get-latest-h40-run", ...input }) as Promise<H40RunSummary | null>;
  }

  getH40RunSummary(input: H40ContextKey & { runId: string }) {
    return this.request({ type: "get-h40-run-summary", ...input }) as Promise<H40RunSummary>;
  }

  completeH40Action(
    input: H40ContextKey & {
      operationId: string;
      persistMs: number;
      runId: string;
      visualMs: number;
    },
  ) {
    return this.request({ type: "complete-h40-action", ...input }) as Promise<H40RunSummary>;
  }

  recordH40Metric(input: H40MetricInput) {
    return this.request({ type: "record-h40-metric", ...input }) as Promise<H40MetricRecord>;
  }

  getH40EvidenceSource(input: H40ContextKey & { runId: string }) {
    return this.request({
      type: "get-h40-evidence-source",
      ...input,
    }) as Promise<H40EvidenceSource>;
  }

  markH40RunExported(input: H40ContextKey & { runId: string }) {
    return this.request({ type: "mark-h40-run-exported", ...input }) as Promise<H40RunSummary>;
  }

  finishH40Run(input: H40ContextKey & { runId: string }) {
    return this.request({ type: "finish-h40-run", ...input }) as Promise<H40FinishResult>;
  }

  abortH40Run(input: H40ContextKey & { runId: string }) {
    return this.request({ type: "abort-h40-run", ...input }) as Promise<H40RunSummary>;
  }

  resolveConflict(input: {
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
  }) {
    return this.request({
      type: "resolve-conflict",
      ...input,
    }) as Promise<ConflictResolutionResult>;
  }

  listHistory(accountId: string, crewId: string, sessionId: string) {
    return this.request({ type: "list-history", accountId, crewId, sessionId }) as Promise<
      LocalOperation[]
    >;
  }

  listPending(accountId: string, crewId: string, sessionId: string) {
    return this.request({ type: "list-pending", accountId, crewId, sessionId }) as Promise<
      LocalOperation[]
    >;
  }

  markSending(accountId: string, crewId: string, sessionId: string, operationIds: string[]) {
    return this.request({
      type: "mark-sending",
      accountId,
      crewId,
      sessionId,
      operationIds,
    });
  }

  restorePending(accountId: string, crewId: string, sessionId: string, operationIds: string[]) {
    return this.request({
      type: "restore-pending",
      accountId,
      crewId,
      sessionId,
      operationIds,
    });
  }

  getCursor(accountId: string, crewId: string, sessionId: string) {
    return this.request({ type: "get-cursor", accountId, crewId, sessionId }) as Promise<{
      cursor: string;
    }>;
  }

  applyResults(
    accountId: string,
    crewId: string,
    sessionId: string,
    results: SyncOperationResult[],
  ) {
    return this.request({ type: "apply-results", accountId, crewId, sessionId, results });
  }

  applyChanges(
    accountId: string,
    crewId: string,
    sessionId: string,
    cursor: string,
    changes: SyncChange[],
  ) {
    return this.request({ type: "apply-changes", accountId, crewId, sessionId, cursor, changes });
  }

  private request(input: RequestWithoutId): Promise<LocalDatabaseResult> {
    if (this.closed) return Promise.reject(new Error("LOCAL_DATABASE_WORKER_UNAVAILABLE"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.failPending(LOCAL_DATABASE_TIMEOUT_ERROR);
      }, this.requestTimeoutMs);
      this.pending.set(id, { reject, resolve, timeout });
      try {
        this.worker.postMessage({ ...input, id } as LocalDatabaseRequest);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("LOCAL_DATABASE_POST_MESSAGE_FAILED"));
      }
    });
  }

  private failPending(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(message);
    this.worker.terminate();
  }

  private rejectPending(message: string): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timeout);
      waiting.reject(new Error(message));
    }
    this.pending.clear();
  }
}
