import {
  RoutePackageDownloadError,
  type RoutePackageDownloadResult,
  downloadRoutePackage as requestRoutePackage,
} from "./routePackageClient";
import type {
  AdminApi,
  AssignCampaignRouteResponse,
  CampaignDetail,
  CampaignSummary,
  CreateCampaignRequest,
  CreateVehicleRequest,
  CurrentWorkSessionResponse,
  DraftChangeResult,
  DraftRevisionChange,
  EditRevisionPointsRequest,
  EditRevisionPointsResponse,
  ImportRouteRequest,
  ImportRouteResponse,
  LoginResponse,
  MeResponse,
  OsmPreview,
  RevisionFeatures,
  RouteDetail,
  RouteSummary,
  SimpleAdminApi,
  SimpleOverview,
  SimpleRouteImportRequest,
  SimpleUser,
  TechnicalContextPackage,
  Vehicle,
} from "./types";

interface ErrorPayload {
  code?: string;
  details?: unknown;
  message?: string;
  errors?: unknown;
  issues?: unknown;
}

const safeErrorMessages: Record<string, string> = {
  INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
  LOGIN_RATE_LIMITED: "Demasiados intentos de ingreso. Espera unos minutos antes de reintentar.",
  FORBIDDEN: "No tienes permisos para realizar esta acción.",
  CAPABILITY_REQUIRED: "No tienes permisos para realizar esta acción.",
  MISSING_SESSION: "Debes iniciar sesión para continuar.",
  MISSING_SESSION_TOKEN: "Debes iniciar sesión para continuar.",
  INVALID_SESSION: "Tu sesión no es válida. Inicia sesión nuevamente.",
  INVALID_SESSION_TOKEN: "Tu sesión no es válida. Inicia sesión nuevamente.",
  REVOKED_SESSION: "Tu sesión expiró o fue revocada.",
  SESSION_REVOKED_OR_EXPIRED: "Tu sesión expiró o fue revocada.",
  INVALID_REVISION_STATE: "Solo puede modificarse o publicarse una revisión en borrador.",
  DRAFT_ALREADY_EXISTS: "Ya existe una revisión en borrador para esta ruta.",
  IDEMPOTENCY_KEY_REUSE: "La clave de operación ya se utilizó con contenido distinto.",
  CSV_VALIDATION_FAILED: "El CSV contiene errores. Corrige las filas indicadas.",
  REVISION_EMPTY: "El borrador debe contener al menos un punto.",
  ROUTE_NOT_FOUND: "La ruta solicitada no existe.",
  REVISION_NOT_FOUND: "La revisión solicitada no existe.",
  INVALID_REQUEST: "La solicitud contiene datos inválidos.",
  DRAFT_VERSION_CONFLICT: "El borrador cambió en otra sesión. Recarga antes de continuar.",
  POINT_OUTSIDE_AREA: "El punto está fuera del área definida para la ruta.",
  INVALID_GEOMETRY: "La geometría no es válida en WGS84.",
  SEGMENT_SIDE_ORIENTATION_INVALID:
    "Para atender un solo lado, los componentes del tramo deben continuar de fin a inicio y compartir un sentido inequívoco.",
  OSM_EXPORT_INVALID: "La exportación OSM/Overpass no tiene un formato compatible.",
  INTERNAL_ERROR: "El servidor no pudo completar la solicitud.",
  CAMPAIGN_NOT_DRAFT: "La composición solo puede cambiar mientras la campaña está en borrador.",
  CAMPAIGN_INVALID_STATE: "La composición solo puede cambiar mientras la campaña está en borrador.",
  CAMPAIGN_EMPTY: "Asigna al menos una ruta y un camión antes de activar la campaña.",
  CAMPAIGN_ROUTE_DUPLICATE: "Esa ruta ya está asignada a la campaña.",
  CAMPAIGN_VEHICLE_DUPLICATE: "Ese camión ya está asignado a otra ruta de la campaña.",
  CAMPAIGN_POINT_DUPLICATE:
    "Un punto con el mismo identificador estable ya pertenece a otra ruta de la campaña.",
  CAMPAIGN_SEGMENT_SIDE_DUPLICATE: "Un lado de calle ya pertenece a otra ruta de la campaña.",
  CAMPAIGN_SEGMENT_VERSION_AMBIGUOUS:
    "No se pudo comprobar que los lados opuestos correspondan a la misma versión de calle.",
  VEHICLE_NOT_ACTIVE: "El camión seleccionado no está activo.",
  ROUTE_REVISION_NOT_ASSIGNABLE: "Solo puedes asignar revisiones publicadas o reemplazadas.",
  CAMPAIGN_ROUTE_REVISION_INVALID: "Solo puedes asignar revisiones publicadas o reemplazadas.",
  CAMPAIGN_ROUTE_HAS_ACTIVITY:
    "La ruta ya tiene actividad registrada y no puede retirarse de la campaña.",
  VEHICLE_DUPLICATE: "Ya existe un camión con ese nombre o patente.",
  VEHICLE_NOT_FOUND: "El camión seleccionado no existe o ya no está activo.",
  CAMPAIGN_NOT_FOUND: "La campaña solicitada no existe.",
  WORK_SESSION_ALREADY_OPEN: "Esta ruta ya tiene una jornada abierta.",
  WORK_SESSION_NOT_ACTIVE: "La jornada ya no está activa.",
  WORK_SESSION_NOT_FOUND: "La jornada solicitada no existe.",
  WORK_SESSION_PARTICIPATION_REQUIRED:
    "Debes incorporarte a la jornada desde este dispositivo antes de operar.",
  WORK_SESSION_VERSION_CONFLICT:
    "La jornada cambió en otro dispositivo. Actualiza e inténtalo nuevamente.",
  CAMPAIGN_INVALID_INPUT: "Revisa el nombre, las fechas, la zona horaria y la moneda.",
  CAMPAIGN_VEHICLE_REQUIRED: "Todas las rutas deben tener un camión activo.",
  CAMPAIGN_ROUTE_NOT_ACTIVE: "Todas las asignaciones deben seguir activas.",
  USER_EMAIL_IN_USE: "Ya existe un usuario con ese correo.",
  SIMPLE_USER_NOT_FOUND: "El usuario ya no está disponible.",
  ROUTE_NOT_PUBLISHED: "La ruta debe contener viviendas antes de asignarla.",
  ROUTE_ALREADY_ASSIGNED: "La ruta ya está asignada a otro usuario.",
  ROUTE_POINT_OVERLAP: "Una vivienda de esta ruta ya pertenece a otra ruta asignada.",
  ROUTE_SEGMENT_SIDE_OVERLAP: "Ese lado de calle ya pertenece a otra ruta asignada.",
  ROUTE_SEGMENT_VERSION_AMBIGUOUS:
    "Los lados opuestos de la calle no usan la misma versión del trazado.",
};

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;
  readonly code?: string;

  constructor(status: number, message: string, details?: unknown, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

export class HttpAdminApi implements AdminApi, SimpleAdminApi {
  private readonly baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    return this.request<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }

  async me(): Promise<MeResponse> {
    return this.request<MeResponse>("/api/me");
  }

  async logout(): Promise<void> {
    try {
      await this.request<void>("/api/auth/logout", { method: "POST" });
    } finally {
      this.token = null;
    }
  }

  async getSimpleOverview(crewId: string): Promise<SimpleOverview> {
    return this.request<SimpleOverview>(
      `/api/simple/admin/crews/${encodeURIComponent(crewId)}/overview`,
    );
  }

  async createSimpleUser(
    crewId: string,
    input: { displayName: string; email: string; password: string },
  ): Promise<SimpleUser> {
    return this.request<SimpleUser>(`/api/simple/admin/crews/${encodeURIComponent(crewId)}/users`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async assignSimpleRoute(crewId: string, userId: string, routeId: string): Promise<void> {
    await this.request(
      `/api/simple/admin/crews/${encodeURIComponent(crewId)}/users/${encodeURIComponent(userId)}/assignment`,
      { method: "PUT", body: JSON.stringify({ routeId }) },
    );
  }

  async unassignSimpleRoute(crewId: string, userId: string): Promise<void> {
    await this.request(
      `/api/simple/admin/crews/${encodeURIComponent(crewId)}/users/${encodeURIComponent(userId)}/assignment`,
      { method: "DELETE" },
    );
  }

  async importSimpleRoute(
    crewId: string,
    input: SimpleRouteImportRequest,
  ): Promise<{ route: RouteDetail }> {
    return this.request<{ route: RouteDetail }>(
      `/api/simple/admin/crews/${encodeURIComponent(crewId)}/routes/import`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async listRoutes(crewId: string): Promise<RouteSummary[]> {
    return this.request<RouteSummary[]>(`/api/crews/${encodeURIComponent(crewId)}/routes`);
  }

  async getRoute(crewId: string, routeId: string): Promise<RouteDetail> {
    return this.request<RouteDetail>(
      `/api/crews/${encodeURIComponent(crewId)}/routes/${encodeURIComponent(routeId)}`,
    );
  }

  async importRoute(crewId: string, input: ImportRouteRequest): Promise<ImportRouteResponse> {
    return this.request<ImportRouteResponse>(
      `/api/crews/${encodeURIComponent(crewId)}/routes/import`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  async editRevisionPoints(
    crewId: string,
    routeId: string,
    revisionId: string,
    input: EditRevisionPointsRequest,
  ): Promise<EditRevisionPointsResponse> {
    return this.request<EditRevisionPointsResponse>(
      "/api/crews/" +
        encodeURIComponent(crewId) +
        "/routes/" +
        encodeURIComponent(routeId) +
        "/revisions/" +
        encodeURIComponent(revisionId) +
        "/points",
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
    );
  }

  async publishRevision(crewId: string, routeId: string, revisionId: string): Promise<RouteDetail> {
    return this.request<RouteDetail>(
      "/api/crews/" +
        encodeURIComponent(crewId) +
        "/routes/" +
        encodeURIComponent(routeId) +
        "/revisions/" +
        encodeURIComponent(revisionId) +
        "/publish",
      { method: "POST" },
    );
  }

  async getRevisionFeatures(
    crewId: string,
    routeId: string,
    revisionId: string,
  ): Promise<RevisionFeatures> {
    const response = await this.request<{
      area: RevisionFeatures["area"];
      bounds: RevisionFeatures["bounds"];
      contentHash?: string;
      draftVersion: number;
      pointCount: number;
      points: {
        features: Array<{
          geometry: { coordinates: [number, number]; type: "Point" };
          id: string;
          properties: Omit<RevisionFeatures["points"][number], "id" | "latitude" | "longitude">;
          type: "Feature";
        }>;
        type: "FeatureCollection";
      };
      revisionId: string;
      routeId: string;
      schemaVersion: 1;
      segmentCount: number;
      segments: {
        features: Array<{
          geometry: RevisionFeatures["segments"][number]["geometry"];
          id: string;
          properties: Omit<RevisionFeatures["segments"][number], "geometry" | "id">;
          type: "Feature";
        }>;
        type: "FeatureCollection";
      };
      status: RevisionFeatures["status"];
    }>(
      `/api/crews/${encodeURIComponent(crewId)}/routes/${encodeURIComponent(routeId)}/revisions/${encodeURIComponent(revisionId)}/features`,
    );
    return {
      area: response.area,
      bounds: response.bounds,
      ...(response.contentHash ? { contentHash: response.contentHash } : {}),
      draftVersion: response.draftVersion,
      pointCount: response.pointCount,
      points: response.points.features.map((feature) => ({
        id: feature.id,
        latitude: feature.geometry.coordinates[1],
        longitude: feature.geometry.coordinates[0],
        ...feature.properties,
      })),
      revisionId: response.revisionId,
      routeId: response.routeId,
      schemaVersion: response.schemaVersion,
      segmentCount: response.segmentCount,
      segments: response.segments.features.map((feature) => ({
        id: feature.id,
        geometry: feature.geometry,
        ...feature.properties,
      })),
      status: response.status,
    };
  }

  async applyDraftChange(
    crewId: string,
    routeId: string,
    revisionId: string,
    input: { operationId: string; baseDraftVersion: number; change: DraftRevisionChange },
  ): Promise<DraftChangeResult> {
    return this.request<DraftChangeResult>(
      `/api/crews/${encodeURIComponent(crewId)}/routes/${encodeURIComponent(routeId)}/revisions/${encodeURIComponent(revisionId)}/changes`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async previewOsmExport(
    crewId: string,
    routeId: string,
    revisionId: string,
    exportPayload: unknown,
  ): Promise<OsmPreview> {
    return this.request<OsmPreview>(
      `/api/crews/${encodeURIComponent(crewId)}/routes/${encodeURIComponent(routeId)}/revisions/${encodeURIComponent(revisionId)}/osm-preview`,
      { method: "POST", body: JSON.stringify({ export: exportPayload }) },
    );
  }

  async createTechnicalContext(
    crewId: string,
    routeRevisionId: string,
    campaignName?: string,
  ): Promise<TechnicalContextPackage> {
    return this.request(`/api/crews/${encodeURIComponent(crewId)}/sync/contexts`, {
      method: "POST",
      body: JSON.stringify({
        routeRevisionId,
        ...(campaignName ? { campaignName } : {}),
      }),
    });
  }

  async listVehicles(crewId: string): Promise<Vehicle[]> {
    return this.request<Vehicle[]>(`/api/crews/${encodeURIComponent(crewId)}/vehicles`);
  }

  async createVehicle(crewId: string, input: CreateVehicleRequest): Promise<Vehicle> {
    return this.request<Vehicle>(`/api/crews/${encodeURIComponent(crewId)}/vehicles`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async listCampaigns(crewId: string): Promise<CampaignSummary[]> {
    return this.request<CampaignSummary[]>(`/api/crews/${encodeURIComponent(crewId)}/campaigns`);
  }

  async getCampaign(crewId: string, campaignId: string): Promise<CampaignDetail> {
    return this.request<CampaignDetail>(
      `/api/crews/${encodeURIComponent(crewId)}/campaigns/${encodeURIComponent(campaignId)}`,
    );
  }

  async createCampaign(crewId: string, input: CreateCampaignRequest): Promise<CampaignDetail> {
    return this.request<CampaignDetail>(`/api/crews/${encodeURIComponent(crewId)}/campaigns`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async assignCampaignRoute(
    crewId: string,
    campaignId: string,
    input: { routeRevisionId: string; vehicleId: string },
  ): Promise<AssignCampaignRouteResponse> {
    return this.request<AssignCampaignRouteResponse>(
      `/api/crews/${encodeURIComponent(crewId)}/campaigns/${encodeURIComponent(campaignId)}/routes`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async removeCampaignRoute(
    crewId: string,
    campaignId: string,
    campaignRouteId: string,
  ): Promise<CampaignDetail> {
    return this.request<CampaignDetail>(
      `/api/crews/${encodeURIComponent(crewId)}/campaigns/${encodeURIComponent(campaignId)}/routes/${encodeURIComponent(campaignRouteId)}`,
      { method: "DELETE" },
    );
  }

  async activateCampaign(crewId: string, campaignId: string): Promise<CampaignDetail> {
    return this.request<CampaignDetail>(
      `/api/crews/${encodeURIComponent(crewId)}/campaigns/${encodeURIComponent(campaignId)}/activate`,
      { method: "POST" },
    );
  }

  async getCurrentWorkSession(
    crewId: string,
    campaignRouteId: string,
  ): Promise<CurrentWorkSessionResponse> {
    return this.request<CurrentWorkSessionResponse>(
      `/api/crews/${encodeURIComponent(crewId)}/campaign-routes/${encodeURIComponent(campaignRouteId)}/work-sessions/current`,
    );
  }

  async downloadRoutePackage(
    crewId: string,
    routeId: string,
    revisionId: string,
    etag?: string,
  ): Promise<RoutePackageDownloadResult> {
    if (!this.token) {
      throw new ApiError(401, "Debes iniciar sesión para preparar una copia local.");
    }
    try {
      return await requestRoutePackage({
        baseUrl: this.baseUrl,
        crewId,
        revisionId,
        routeId,
        token: this.token,
        ...(etag === undefined ? {} : { etag }),
      });
    } catch (error) {
      if (error instanceof RoutePackageDownloadError) {
        throw new ApiError(error.status, error.message, undefined, error.code);
      }
      throw error;
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (this.token) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }

    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, { ...init, headers });
    } catch {
      throw new ApiError(
        0,
        "No fue posible conectar con el servidor. Revisa la URL de la API y tu conexión.",
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    const hasJson = contentType.includes("application/json");
    const payload =
      response.status === 204
        ? undefined
        : hasJson
          ? ((await response.json()) as ErrorPayload | T)
          : await response.text();

    if (!response.ok) {
      const errorPayload =
        typeof payload === "object" && payload !== null ? (payload as ErrorPayload) : undefined;
      const fallback =
        response.status === 401
          ? "La sesión no es válida o expiró."
          : response.status === 403
            ? "No tienes permisos para realizar esta acción."
            : response.status === 409
              ? "La operación entra en conflicto con el estado actual."
              : response.status === 422
                ? "El servidor encontró errores en los datos enviados."
                : "La solicitud no pudo completarse.";
      const safeMessage = errorPayload?.code
        ? (safeErrorMessages[errorPayload.code] ?? fallback)
        : (errorPayload?.message ?? fallback);
      throw new ApiError(
        response.status,
        safeMessage,
        errorPayload?.details ?? errorPayload?.errors ?? errorPayload?.issues,
        errorPayload?.code,
      );
    }

    return payload as T;
  }
}

export function createHttpAdminApi(): AdminApi & SimpleAdminApi {
  const configured = import.meta.env.VITE_API_URL?.trim();
  const localDefault = ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname)
    ? `${window.location.protocol}//${window.location.hostname}:4310`
    : "";
  return new HttpAdminApi(configured || localDefault);
}
