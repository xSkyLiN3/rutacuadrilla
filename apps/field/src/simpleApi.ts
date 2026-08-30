import type { FieldPoint, FieldSegment, FieldUser, PointState } from "./types";

export interface SimpleFieldProgress {
  assignmentId: string;
  routeId: string;
  routeName: string;
  states: Record<PointState, number>;
  total: number;
  updatedAt: string;
  user: { id: string; name: string };
  visited: number;
}

export interface SimpleFieldAssignment {
  crew: { id: string; name: string };
  id: string;
  points: FieldPoint[];
  progress: SimpleFieldProgress;
  route: { id: string; name: string; revisionId: string };
  segments: FieldSegment[];
}

interface LoginResponse {
  expiresAt: string;
  memberships: Array<{ crewId: string; crewName: string; membershipId: string; role: string }>;
  token: string;
  user: FieldUser;
}

interface MeResponse {
  memberships: LoginResponse["memberships"];
  user: FieldUser;
}

export interface SimpleFieldApiPort {
  setToken(token: string | null): void;
  login(email: string, password: string): Promise<LoginResponse>;
  me(): Promise<MeResponse>;
  logout(): Promise<void>;
  assignment(): Promise<SimpleFieldAssignment | null>;
  updatePoint(
    pointId: string,
    input: { expectedVersion: number; operationId: string; state: PointState },
  ): Promise<{
    point: { id: string; state: PointState; version: number };
    progress: SimpleFieldProgress;
    replayed: boolean;
  }>;
}

export class SimpleFieldApiError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly status: number;

  constructor(status: number, message: string, code = "", details?: unknown) {
    super(message);
    this.name = "SimpleFieldApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
  LOGIN_RATE_LIMITED: "Demasiados intentos. Espera unos minutos e inténtalo nuevamente.",
  MISSING_SESSION: "Debes iniciar sesión para continuar.",
  INVALID_SESSION: "La sesión no es válida. Inicia sesión nuevamente.",
  SESSION_REVOKED_OR_EXPIRED: "La sesión expiró. Inicia sesión nuevamente.",
  ASSIGNMENT_POINT_NOT_FOUND: "Esta vivienda ya no pertenece a tu ruta activa.",
  POINT_VERSION_CONFLICT: "La vivienda cambió desde otro navegador. Se cargó el estado vigente.",
  IDEMPOTENCY_KEY_REUSE: "La operación no pudo repetirse de forma segura.",
};

function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (["127.0.0.1", "localhost", "::1"].includes(window.location.hostname)) {
    return `${window.location.protocol}//${window.location.hostname}:4310`;
  }
  return "";
}

export class SimpleFieldApi implements SimpleFieldApiPort {
  private readonly baseUrl = apiBaseUrl();
  private assignmentCache: {
    etag: string;
    value: SimpleFieldAssignment | null;
  } | null = null;
  private token: string | null = null;

  setToken(token: string | null): void {
    this.assignmentCache = null;
    this.token = token;
  }

  login(email: string, password: string): Promise<LoginResponse> {
    return this.request<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }

  me(): Promise<MeResponse> {
    return this.request<MeResponse>("/api/me");
  }

  async logout(): Promise<void> {
    try {
      await this.request("/api/auth/logout", { method: "POST" });
    } finally {
      this.setToken(null);
    }
  }

  async assignment(): Promise<SimpleFieldAssignment | null> {
    const headers = new Headers();
    if (this.assignmentCache) headers.set("If-None-Match", this.assignmentCache.etag);
    const result = await this.requestWithResponse<{
      assignment: SimpleFieldAssignment | null;
    }>("/api/simple/field/assignment", { cache: "no-store", headers }, [304]);
    if (result.response.status === 304) {
      if (this.assignmentCache) return this.assignmentCache.value;
      throw new SimpleFieldApiError(502, "El servidor devolvió una actualización incompleta.");
    }

    const value = result.payload?.assignment ?? null;
    const etag = result.response.headers.get("ETag")?.trim();
    this.assignmentCache = etag ? { etag, value } : null;
    return value;
  }

  async updatePoint(
    pointId: string,
    input: { expectedVersion: number; operationId: string; state: PointState },
  ): Promise<{
    point: { id: string; state: PointState; version: number };
    progress: SimpleFieldProgress;
    replayed: boolean;
  }> {
    const result = await this.request<{
      point: { id: string; state: PointState; version: number };
      progress: SimpleFieldProgress;
      replayed: boolean;
    }>(`/api/simple/field/assignment/points/${encodeURIComponent(pointId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    this.assignmentCache = null;
    return result;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const result = await this.requestWithResponse<T>(path, init);
    return result.payload as T;
  }

  private async requestWithResponse<T>(
    path: string,
    init: RequestInit = {},
    allowedStatuses: readonly number[] = [],
  ): Promise<{ payload: T | undefined; response: Response }> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);

    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(12_000),
      });
    } catch {
      throw new SimpleFieldApiError(0, "Sin conexión con el servidor.");
    }

    const rawBody = await response.text();
    let payload: unknown;
    try {
      payload = rawBody ? (JSON.parse(rawBody) as unknown) : undefined;
    } catch {
      payload = undefined;
    }
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      const body =
        payload && typeof payload === "object"
          ? (payload as { code?: string; details?: unknown })
          : {};
      const code = body.code ?? "";
      const fallback =
        response.status === 401
          ? "La sesión no es válida o expiró."
          : response.status === 409
            ? "El estado cambió. Actualiza e inténtalo otra vez."
            : "No fue posible completar la operación.";
      throw new SimpleFieldApiError(
        response.status,
        ERROR_MESSAGES[code] ?? fallback,
        code,
        body.details,
      );
    }
    return { payload: payload as T | undefined, response };
  }
}
