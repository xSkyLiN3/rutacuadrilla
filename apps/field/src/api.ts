import { normalizeFieldSegments } from "./streetSide";
import type {
  FieldContextPackage,
  FieldContextSummary,
  FieldMembership,
  FieldSegment,
  FieldUser,
  LocalOperation,
  LocalWorkSession,
  PointState,
  SyncChange,
  SyncOperationResult,
} from "./types";

const SYNC_CONTRACT_VERSION = "p0-provisional-v3" as const;
const POINT_STATES = new Set<PointState>([
  "SIN_VISITAR",
  "SOBRE_ENTREGADO",
  "VOLVER",
  "SIN_RESPUESTA",
  "APORTO",
  "NO_PARTICIPA",
]);
const RESULT_STATUSES = new Set<SyncOperationResult["status"]>([
  "APPLIED",
  "BLOCKED_DEPENDENCY",
  "CONFLICT",
  "REJECTED",
]);

function isPointState(value: unknown): value is PointState {
  return typeof value === "string" && POINT_STATES.has(value as PointState);
}

function isContextSummary(value: unknown): value is FieldContextSummary {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<FieldContextSummary>;
  return (
    typeof context.campaignId === "string" &&
    typeof context.campaignName === "string" &&
    typeof context.contentHash === "string" &&
    typeof context.id === "string" &&
    Number.isInteger(context.pointCount) &&
    Number(context.pointCount) >= 0 &&
    typeof context.routeId === "string" &&
    typeof context.routeName === "string" &&
    typeof context.routeRevisionId === "string" &&
    Number.isInteger(context.segmentCount) &&
    Number(context.segmentCount) >= 0 &&
    ((context.vehicleId === undefined && context.vehicleName === undefined) ||
      (typeof context.vehicleId === "string" &&
        context.vehicleId.length > 0 &&
        typeof context.vehicleName === "string" &&
        context.vehicleName.length > 0))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function parseMemberships(value: unknown): FieldMembership[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (membership) =>
        !membership ||
        typeof membership !== "object" ||
        !isNonEmptyString(membership.crewId) ||
        !isNonEmptyString(membership.crewName) ||
        !isNonEmptyString(membership.membershipId) ||
        (membership.role !== "ADMIN" && membership.role !== "MEMBER"),
    )
  ) {
    throw new FieldApiError(409, "Las membresías recibidas no son compatibles.");
  }
  const memberships = value as FieldMembership[];
  if (
    new Set(memberships.map((membership) => membership.crewId)).size !== memberships.length ||
    new Set(memberships.map((membership) => membership.membershipId)).size !== memberships.length
  ) {
    throw new FieldApiError(409, "Las membresías recibidas están duplicadas.");
  }
  return memberships;
}

function parseUser(value: unknown): FieldUser {
  if (
    !value ||
    typeof value !== "object" ||
    !isNonEmptyString((value as Partial<FieldUser>).id) ||
    !isNonEmptyString((value as Partial<FieldUser>).email) ||
    !isNonEmptyString((value as Partial<FieldUser>).name)
  ) {
    throw new FieldApiError(409, "La identidad recibida no es compatible.");
  }
  return value as FieldUser;
}

function parseWorkSession(value: unknown): LocalWorkSession {
  if (!value || typeof value !== "object") {
    throw new FieldApiError(409, "La jornada recibida no es compatible.");
  }
  const session = value as Partial<LocalWorkSession>;
  const participants = session.participants;
  const devices = session.devices;
  if (
    !isNonEmptyString(session.id) ||
    !isNonEmptyString(session.campaignId) ||
    !isNonEmptyString(session.campaignRouteId) ||
    (session.status !== "ACTIVE" && session.status !== "FINISHED") ||
    !Number.isInteger(session.version) ||
    Number(session.version) < 1 ||
    !isTimestamp(session.startedAt) ||
    !isNonEmptyString(session.startedByDeviceId) ||
    !isNonEmptyString(session.startedByMembershipId) ||
    (session.finishedAt !== undefined && !isTimestamp(session.finishedAt)) ||
    (session.finishedByMembershipId !== undefined &&
      !isNonEmptyString(session.finishedByMembershipId)) ||
    (session.status === "ACTIVE" && session.finishedAt !== undefined) ||
    (session.status === "FINISHED" && session.finishedAt === undefined) ||
    !Array.isArray(participants) ||
    participants.some(
      (participant) =>
        !participant ||
        typeof participant !== "object" ||
        !isNonEmptyString(participant.membershipId) ||
        !isNonEmptyString(participant.displayName) ||
        !isTimestamp(participant.joinedAt) ||
        !["ASSISTANT", "DRIVER", "OTHER"].includes(participant.profile),
    ) ||
    !Array.isArray(devices) ||
    devices.some(
      (device) =>
        !device ||
        typeof device !== "object" ||
        !isNonEmptyString(device.deviceId) ||
        !isNonEmptyString(device.membershipId) ||
        !isTimestamp(device.joinedAt),
    )
  ) {
    throw new FieldApiError(409, "La jornada recibida no es compatible.");
  }
  const membershipIds = new Set(participants.map((participant) => participant.membershipId));
  if (
    membershipIds.size !== participants.length ||
    new Set(devices.map((device) => device.deviceId)).size !== devices.length ||
    devices.some((device) => !membershipIds.has(device.membershipId)) ||
    !membershipIds.has(session.startedByMembershipId) ||
    !devices.some(
      (device) =>
        device.deviceId === session.startedByDeviceId &&
        device.membershipId === session.startedByMembershipId,
    ) ||
    (session.finishedByMembershipId !== undefined &&
      !membershipIds.has(session.finishedByMembershipId))
  ) {
    throw new FieldApiError(409, "La composición de la jornada no es compatible.");
  }
  return session as LocalWorkSession;
}

function parseWorkSessionMutation(value: unknown): {
  replayed: boolean;
  workSession: LocalWorkSession;
} {
  if (!value || typeof value !== "object") {
    throw new FieldApiError(409, "La respuesta de jornada no es compatible.");
  }
  const response = value as { replayed?: unknown; workSession?: unknown };
  if (typeof response.replayed !== "boolean") {
    throw new FieldApiError(409, "La respuesta de jornada no es compatible.");
  }
  return {
    replayed: response.replayed,
    workSession: parseWorkSession(response.workSession),
  };
}

interface LoginResponse {
  expiresAt: string;
  memberships: FieldMembership[];
  token: string;
  user: FieldUser;
}

interface MeResponse {
  memberships: FieldMembership[];
  user: FieldUser;
}

interface ContextDetailResponse {
  contractVersion: "p0-provisional-v3";
  context: FieldContextSummary;
  segments: unknown;
  points: Array<{
    displayOrder: number;
    displayState: PointState;
    externalId: string;
    id: string;
    latitude: number;
    longitude: number;
    number?: string;
    pointType: string;
    street?: string;
    version: number;
  }>;
}

export class FieldApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FieldApiError";
  }
}

export class FieldApi {
  private token: string | null = null;
  private readonly baseUrl: string;

  constructor(baseUrl = resolveApiBaseUrl(import.meta.env.VITE_API_URL)) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    const response = await this.request<Partial<LoginResponse>>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!isNonEmptyString(response.token) || !isTimestamp(response.expiresAt)) {
      throw new FieldApiError(409, "La sesión recibida no es compatible.");
    }
    return {
      expiresAt: response.expiresAt,
      memberships: parseMemberships(response.memberships),
      token: response.token,
      user: parseUser(response.user),
    };
  }

  async me(): Promise<MeResponse> {
    const response = await this.request<Partial<MeResponse>>("/api/me");
    return {
      memberships: parseMemberships(response.memberships),
      user: parseUser(response.user),
    };
  }

  async logout(): Promise<void> {
    const response = await this.fetchResponse("/api/auth/logout", { method: "POST" });
    const rawBody = await response.text();
    if (!response.ok) throw this.responseError(response.status, rawBody);
  }

  async listContexts(crewId: string): Promise<FieldContextSummary[]> {
    const response = await this.request<{ contexts?: unknown }>(
      `/api/crews/${encodeURIComponent(crewId)}/sync/contexts`,
    );
    if (
      !Array.isArray(response.contexts) ||
      response.contexts.some((item) => !isContextSummary(item))
    ) {
      throw new FieldApiError(409, "La lista de contextos no incluye conteos compatibles.");
    }
    return response.contexts;
  }

  async downloadContext(crewId: string, contextId: string): Promise<FieldContextPackage> {
    const httpResponse = await this.fetchResponse(
      `/api/crews/${encodeURIComponent(crewId)}/sync/contexts/${encodeURIComponent(contextId)}`,
    );
    const rawBody = await httpResponse.text();
    if (!httpResponse.ok) {
      throw this.responseError(httpResponse.status, rawBody);
    }
    const expectedSha256 = httpResponse.headers.get("X-Package-SHA256")?.toLowerCase();
    const transportSha256 = await sha256Hex(rawBody);
    const expectedEtag = `"sha256-${transportSha256}"`;
    const declaredLength = httpResponse.headers.get("Content-Length");
    if (
      !expectedSha256 ||
      expectedSha256 !== transportSha256 ||
      httpResponse.headers.get("ETag") !== expectedEtag ||
      (declaredLength !== null &&
        Number(declaredLength) !== new TextEncoder().encode(rawBody).byteLength)
    ) {
      throw new FieldApiError(409, "La copia local no superó la verificación de integridad.");
    }
    let response: ContextDetailResponse;
    try {
      response = JSON.parse(rawBody) as ContextDetailResponse;
    } catch {
      throw new FieldApiError(409, "La copia local no contiene JSON válido.");
    }
    if (
      !response ||
      typeof response !== "object" ||
      !response.context ||
      !Array.isArray(response.points) ||
      response.contractVersion !== SYNC_CONTRACT_VERSION ||
      response.context.id !== contextId ||
      !Number.isInteger(response.context.pointCount) ||
      response.context.pointCount !== response.points.length ||
      !Number.isInteger(response.context.segmentCount)
    ) {
      throw new FieldApiError(409, "La versión del paquete de campo no es compatible.");
    }
    let segments: FieldSegment[];
    try {
      segments = normalizeFieldSegments(response.segments);
    } catch {
      throw new FieldApiError(409, "Los tramos del paquete de campo no son compatibles.");
    }
    if (response.context.segmentCount !== segments.length) {
      throw new FieldApiError(409, "El conteo de tramos del paquete no coincide con su contenido.");
    }
    return {
      schemaVersion: 1,
      crewId,
      campaignId: response.context.campaignId,
      campaignRouteId: response.context.id,
      sessionId: response.context.id,
      routeId: response.context.routeId,
      routeRevisionId: response.context.routeRevisionId,
      routeName: response.context.routeName,
      contentHash: response.context.contentHash,
      rawBody,
      transportSha256,
      ...(response.context.vehicleId ? { vehicleId: response.context.vehicleId } : {}),
      ...(response.context.vehicleName ? { vehicleName: response.context.vehicleName } : {}),
      segments,
      points: response.points.map((point) => ({
        id: point.id,
        externalId: point.externalId,
        displayOrder: point.displayOrder,
        ...(point.street ? { street: point.street } : {}),
        ...(point.number ? { number: point.number } : {}),
        latitude: point.latitude,
        longitude: point.longitude,
        pointType: point.pointType,
        state: point.displayState,
        version: point.version,
      })),
    };
  }

  async getCurrentWorkSession(
    crewId: string,
    campaignRouteId: string,
  ): Promise<LocalWorkSession | null> {
    const response = await this.fetchResponse(
      `/api/crews/${encodeURIComponent(crewId)}/campaign-routes/${encodeURIComponent(campaignRouteId)}/work-sessions/current`,
    );
    const rawBody = await response.text();
    if (!response.ok) throw this.responseError(response.status, rawBody);
    let value: unknown;
    try {
      value = JSON.parse(rawBody) as unknown;
    } catch {
      throw new FieldApiError(409, "El servidor devolvió una jornada inválida.");
    }
    if (
      value &&
      typeof value === "object" &&
      Object.hasOwn(value, "workSession") &&
      (value as { workSession?: unknown }).workSession == null
    ) {
      return null;
    }
    if (!value || typeof value !== "object" || !Object.hasOwn(value, "workSession")) {
      throw new FieldApiError(409, "La respuesta de jornada actual no es compatible.");
    }
    return parseWorkSession((value as { workSession?: unknown }).workSession);
  }

  async startWorkSession(
    crewId: string,
    campaignRouteId: string,
    input: { deviceId: string; operationId: string },
  ) {
    const response = await this.request<unknown>(
      `/api/crews/${encodeURIComponent(crewId)}/campaign-routes/${encodeURIComponent(campaignRouteId)}/work-sessions`,
      { body: JSON.stringify(input), method: "POST" },
    );
    const mutation = parseWorkSessionMutation(response);
    if (
      !response ||
      typeof response !== "object" ||
      typeof (response as { created?: unknown }).created !== "boolean"
    ) {
      throw new FieldApiError(409, "La respuesta de inicio de jornada no es compatible.");
    }
    return { ...mutation, created: (response as { created: boolean }).created };
  }

  async getWorkSession(crewId: string, workSessionId: string): Promise<LocalWorkSession> {
    const response = await this.request<unknown>(
      `/api/crews/${encodeURIComponent(crewId)}/work-sessions/${encodeURIComponent(workSessionId)}`,
    );
    return parseWorkSession(response);
  }

  async joinWorkSession(
    crewId: string,
    workSessionId: string,
    input: { deviceId: string; operationId: string },
  ) {
    const response = await this.request<unknown>(
      `/api/crews/${encodeURIComponent(crewId)}/work-sessions/${encodeURIComponent(workSessionId)}/join`,
      { body: JSON.stringify(input), method: "POST" },
    );
    const mutation = parseWorkSessionMutation(response);
    if (
      !response ||
      typeof response !== "object" ||
      typeof (response as { deviceJoined?: unknown }).deviceJoined !== "boolean" ||
      typeof (response as { participantJoined?: unknown }).participantJoined !== "boolean"
    ) {
      throw new FieldApiError(409, "La respuesta de unión a jornada no es compatible.");
    }
    return {
      ...mutation,
      deviceJoined: (response as { deviceJoined: boolean }).deviceJoined,
      participantJoined: (response as { participantJoined: boolean }).participantJoined,
    };
  }

  async finishWorkSession(
    crewId: string,
    workSessionId: string,
    input: { expectedVersion: number; operationId: string },
  ) {
    const response = await this.request<unknown>(
      `/api/crews/${encodeURIComponent(crewId)}/work-sessions/${encodeURIComponent(workSessionId)}/finish`,
      { body: JSON.stringify(input), method: "POST" },
    );
    return parseWorkSessionMutation(response);
  }

  async pushCommands(crewId: string, operations: LocalOperation[]): Promise<SyncOperationResult[]> {
    if (operations.some((operation) => !operation.workSessionId)) {
      throw new FieldApiError(
        409,
        "Hay operaciones heredadas conservadas que no pueden atribuirse a esta jornada.",
      );
    }
    const response = await this.request<{
      contractVersion: string;
      results: Array<{
        campaignPointId: string;
        canonicalState?: PointState;
        canonicalVersion?: number;
        code?: string;
        operationId: string;
        replayed: boolean;
        state?: PointState;
        status: SyncOperationResult["status"];
        version?: number;
        workSessionId: string;
      }>;
    }>(`/api/crews/${encodeURIComponent(crewId)}/sync/commands`, {
      method: "POST",
      body: JSON.stringify({
        commands: operations.map((operation) => ({
          operationId: operation.operationId,
          deviceId: operation.deviceId,
          campaignPointId: operation.aggregateId,
          workSessionId: operation.workSessionId,
          type: operation.undoesOperationId ? "POINT_STATUS_REVERTED" : "POINT_STATUS_CHANGED",
          baseVersion: operation.baseVersion,
          ...(operation.dependsOnOperationId
            ? { dependsOnOperationId: operation.dependsOnOperationId }
            : {}),
          payload: operation.undoesOperationId
            ? { revertsOperationId: operation.undoesOperationId }
            : { state: operation.toState },
        })),
      }),
    });
    const expectedPoints = new Map(
      operations.map((operation) => [operation.operationId, operation.aggregateId]),
    );
    const expectedSessions = new Map(
      operations.map((operation) => [operation.operationId, operation.workSessionId]),
    );
    const returnedOperations = new Set<string>();
    if (
      response.contractVersion !== SYNC_CONTRACT_VERSION ||
      !Array.isArray(response.results) ||
      response.results.length !== operations.length ||
      response.results.some((result) => {
        if (!result || typeof result !== "object") return true;
        const expectedPoint = expectedPoints.get(result.operationId);
        const hasStateVersion =
          isPointState(result.state) &&
          Number.isInteger(result.version) &&
          Number(result.version) >= 0;
        const suppliedStateVersion = result.state !== undefined || result.version !== undefined;
        const hasCanonicalStateVersion =
          isPointState(result.canonicalState) &&
          Number.isInteger(result.canonicalVersion) &&
          Number(result.canonicalVersion) >= 0;
        const suppliedCanonicalStateVersion =
          result.canonicalState !== undefined || result.canonicalVersion !== undefined;
        const requiresStateVersion = result.status !== "BLOCKED_DEPENDENCY";
        if (
          !expectedPoint ||
          returnedOperations.has(result.operationId) ||
          result.campaignPointId !== expectedPoint ||
          result.workSessionId !== expectedSessions.get(result.operationId) ||
          !RESULT_STATUSES.has(result.status) ||
          typeof result.replayed !== "boolean" ||
          (requiresStateVersion && !hasStateVersion) ||
          (suppliedStateVersion && !hasStateVersion) ||
          (suppliedCanonicalStateVersion && !hasCanonicalStateVersion) ||
          (hasCanonicalStateVersion &&
            hasStateVersion &&
            (result.canonicalState !== result.state || result.canonicalVersion !== result.version))
        ) {
          return true;
        }
        returnedOperations.add(result.operationId);
        return false;
      })
    ) {
      throw new FieldApiError(
        409,
        "La respuesta de sincronización no coincide con el lote enviado.",
      );
    }
    return response.results.map((result) => ({
      operationId: result.operationId,
      status: result.status,
      replayed: result.replayed,
      ...(result.state ? { state: result.state } : {}),
      ...(result.version !== undefined ? { version: result.version } : {}),
      ...(result.canonicalState ? { canonicalState: result.canonicalState } : {}),
      ...(result.canonicalVersion !== undefined
        ? { canonicalVersion: result.canonicalVersion }
        : {}),
      ...(result.code ? { code: result.code } : {}),
      workSessionId: result.workSessionId,
    }));
  }

  async pullChanges(
    crewId: string,
    after: string,
  ): Promise<{ changes: SyncChange[]; cursor: string; hasMore: boolean }> {
    const query = new URLSearchParams({ limit: "200" });
    if (after) query.set("after", after);
    const response = await this.request<{
      contractVersion: string;
      changes: Array<{
        campaignPointId: string;
        sequence: number;
        state: PointState;
        version: number;
        workSessionId?: string;
      }>;
      cursor: string;
      hasMore: boolean;
    }>(`/api/crews/${encodeURIComponent(crewId)}/sync/changes?${query.toString()}`);
    if (
      response.contractVersion !== SYNC_CONTRACT_VERSION ||
      !Array.isArray(response.changes) ||
      typeof response.cursor !== "string" ||
      typeof response.hasMore !== "boolean" ||
      response.changes.some(
        (change, index) =>
          typeof change.campaignPointId !== "string" ||
          change.campaignPointId.length === 0 ||
          !Number.isInteger(change.sequence) ||
          change.sequence <= 0 ||
          !isPointState(change.state) ||
          !Number.isInteger(change.version) ||
          change.version < 0 ||
          (change.workSessionId !== undefined &&
            (typeof change.workSessionId !== "string" || change.workSessionId.length === 0)) ||
          (index > 0 && change.sequence <= (response.changes[index - 1]?.sequence ?? 0)),
      ) ||
      (response.changes.length > 0 && response.cursor === after) ||
      (response.hasMore && response.changes.length === 0)
    ) {
      throw new FieldApiError(409, "La versión de sincronización no es compatible.");
    }
    return {
      cursor: response.cursor,
      hasMore: response.hasMore,
      changes: response.changes.map((change) => ({
        pointId: change.campaignPointId,
        sequence: change.sequence,
        state: change.state,
        version: change.version,
        ...(change.workSessionId ? { workSessionId: change.workSessionId } : {}),
      })),
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchResponse(path, init);
    const rawBody = await response.text();
    if (!response.ok) throw this.responseError(response.status, rawBody);
    try {
      return JSON.parse(rawBody) as T;
    } catch {
      throw new FieldApiError(response.status, "El servidor devolvió una respuesta inválida.");
    }
  }

  private async fetchResponse(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(10_000),
      });
    } catch {
      throw new FieldApiError(0, "Sin conexión con el servidor.");
    }
    return response;
  }

  private responseError(status: number, rawBody: string): FieldApiError {
    let code = "";
    try {
      code = (JSON.parse(rawBody) as { code?: string }).code ?? "";
    } catch {
      // El mensaje público no incorpora el cuerpo no confiable.
    }
    const messages: Record<string, string> = {
      INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
      LOGIN_RATE_LIMITED:
        "Demasiados intentos de ingreso. Espera unos minutos antes de reintentar.",
      FORBIDDEN: "No tienes permiso para este contexto.",
      SESSION_REVOKED_OR_EXPIRED: "La sesión expiró o fue revocada.",
      WORK_SESSION_NOT_FOUND: "La jornada ya no está disponible.",
      WORK_SESSION_NOT_ACTIVE: "La jornada ya finalizó y no admite cambios.",
      WORK_SESSION_ALREADY_OPEN: "Ya existe una jornada activa para esta ruta.",
      WORK_SESSION_DEVICE_CONFLICT:
        "Este dispositivo ya está vinculado a otro participante de la jornada.",
      WORK_SESSION_PARTICIPATION_REQUIRED: "Debes formar parte de la jornada antes de finalizarla.",
      WORK_SESSION_SCOPE_MISMATCH: "La jornada no corresponde a este contexto de trabajo.",
      WORK_SESSION_VERSION_CONFLICT:
        "La jornada cambió en otro dispositivo. Actualiza e intenta nuevamente.",
    };
    return new FieldApiError(
      status,
      (code && messages[code]) || "No fue posible completar la operación.",
    );
  }
}

export function resolveApiBaseUrl(configured: string | undefined): string {
  if (configured?.trim()) return configured.trim();
  if (
    typeof window !== "undefined" &&
    ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname)
  ) {
    return `${window.location.protocol}//${window.location.hostname}:4310`;
  }
  return "";
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
