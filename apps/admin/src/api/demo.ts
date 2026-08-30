import { parseRouteCsv } from "../lib/csv";
import { ApiError } from "./client";
import type {
  AdminApi,
  CampaignDetail,
  CampaignRouteAssignment,
  CampaignSummary,
  CreateCampaignRequest,
  CreateVehicleRequest,
  CurrentWorkSessionResponse,
  DraftRevisionChange,
  EditRevisionPointsRequest,
  EditRevisionPointsResponse,
  ImportRouteRequest,
  ImportRouteResponse,
  LoginResponse,
  Membership,
  MeResponse,
  OsmPreview,
  RevisionFeatures,
  RevisionStreetSegment,
  RouteDetail,
  RoutePoint,
  RouteRevision,
  RouteSummary,
  User,
  Vehicle,
} from "./types";

interface DemoApiOptions {
  delayMs?: number;
}

const DEMO_USER: User = {
  id: "user-demo-admin",
  name: "Camila Administradora",
  email: "admin@demo.cl",
};

const DEMO_MEMBERSHIPS: Membership[] = [
  { crewId: "crew-halcones", crewName: "Los Halcones", role: "ADMIN" },
  { crewId: "crew-costa", crewName: "Cuadrilla Costa", role: "ADMIN" },
  { crewId: "crew-empty", crewName: "Tripulación sin rutas", role: "ADMIN" },
  { crewId: "crew-forbidden", crewName: "Acceso restringido", role: "MEMBER" },
  { crewId: "crew-error", crewName: "Servidor inestable", role: "ADMIN" },
];

function makeRevision(
  id: string,
  number: number | null,
  status: RouteRevision["status"],
  points: RoutePoint[],
  createdAt: string,
  publishedAt?: string,
): RouteRevision {
  return {
    area: null,
    draftVersion: 1,
    id,
    number,
    status,
    contentHash: publishedAt ? `demo-content:${id}` : undefined,
    pointCount: points.length,
    segmentCount: 0,
    points,
    createdAt,
    publishedAt,
  };
}

const sectorAPoints: RoutePoint[] = [
  {
    id: "point-a-1",
    externalId: "home-a-001",
    servicePointVersionId: "point-version-a-1",
    street: "Los Aromos",
    number: "120",
    latitude: -0.4512,
    longitude: -0.6621,
    pointType: "DWELLING",
    source: "CSV",
  },
  {
    id: "point-a-2",
    externalId: "home-a-002",
    servicePointVersionId: "point-version-a-2",
    street: "Los Aromos",
    number: "126",
    latitude: -0.4517,
    longitude: -0.6614,
    pointType: "DWELLING",
    source: "CSV",
  },
  {
    id: "point-a-3",
    externalId: "access-a-003",
    servicePointVersionId: "point-version-a-3",
    street: "Las Flores",
    number: "45",
    latitude: -0.4523,
    longitude: -0.6606,
    pointType: "BUILDING_ENTRANCE",
    source: "CSV",
  },
];

const sectorBPoints: RoutePoint[] = [
  {
    id: "point-b-1",
    externalId: "home-b-001",
    servicePointVersionId: "point-version-b-1",
    street: "Los Maitenes",
    number: "10",
    latitude: -0.458,
    longitude: -0.669,
    pointType: "DWELLING",
    source: "CSV",
  },
  {
    id: "point-b-2",
    externalId: "special-b-002",
    servicePointVersionId: "point-version-b-2",
    street: "Las Acacias",
    number: "38",
    latitude: -0.4586,
    longitude: -0.6684,
    pointType: "SPECIAL",
    source: "CSV",
  },
];

const INITIAL_SEGMENTS_BY_REVISION: Record<string, RevisionStreetSegment[]> = {
  "revision-a-1": [
    {
      id: "segment-published-left",
      streetSegmentVersionId: "segment-version-published-left",
      displayOrder: 0,
      externalId: "manual/los-aromos-publicada",
      name: "Los Aromos",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-0.6624, -0.4509],
            [-0.6611, -0.4519],
          ],
        ],
      },
      serviceSide: "LEFT",
      source: "MANUAL",
    },
  ],
  "revision-a-2": [
    {
      id: "segment-a-left",
      streetSegmentVersionId: "segment-version-a-left",
      displayOrder: 0,
      externalId: "manual/los-aromos-norte",
      name: "Los Aromos",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-0.6624, -0.4509],
            [-0.6611, -0.4519],
          ],
        ],
      },
      serviceSide: "LEFT",
      source: "MANUAL",
    },
    {
      id: "segment-a-right",
      streetSegmentVersionId: "segment-version-a-right",
      displayOrder: 1,
      externalId: "manual/las-flores-sur",
      name: "Las Flores",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-0.6611, -0.4519],
            [-0.6604, -0.4525],
          ],
        ],
      },
      serviceSide: "RIGHT",
      source: "MANUAL",
    },
    {
      id: "segment-a-both",
      streetSegmentVersionId: "segment-version-a-both",
      displayOrder: 2,
      externalId: "manual/pasaje-central",
      name: "Pasaje Central",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-0.6604, -0.4525],
            [-0.6597, -0.4531],
          ],
        ],
      },
      serviceSide: "BOTH",
      source: "MANUAL",
    },
  ],
  "revision-b-1": [
    {
      id: "segment-published-left",
      streetSegmentVersionId: "segment-version-published-left",
      displayOrder: 0,
      externalId: "manual/los-aromos-publicada",
      name: "Los Aromos",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-0.6624, -0.4509],
            [-0.6611, -0.4519],
          ],
        ],
      },
      serviceSide: "RIGHT",
      source: "MANUAL",
    },
  ],
};

function createInitialRoutes(): Record<string, RouteDetail[]> {
  return {
    "crew-halcones": [
      {
        id: "route-sector-a",
        crewId: "crew-halcones",
        name: "Ruta Sector A",
        sectorName: "Sector A",
        updatedAt: "2026-08-10T18:30:00.000Z",
        revisions: [
          makeRevision(
            "revision-a-1",
            1,
            "PUBLISHED",
            sectorAPoints,
            "2026-07-20T15:00:00.000Z",
            "2026-07-21T12:00:00.000Z",
          ),
          makeRevision(
            "revision-a-2",
            null,
            "DRAFT",
            [
              ...sectorAPoints,
              {
                id: "point-a-4",
                externalId: "access-a-004",
                servicePointVersionId: "point-version-a-4",
                street: "Pasaje Central",
                number: "S/N",
                latitude: -0.4529,
                longitude: -0.6599,
                pointType: "COMPLEX_ACCESS",
                source: "MANUAL",
              },
            ],
            "2026-08-10T18:30:00.000Z",
          ),
        ],
      },
      {
        id: "route-sector-b",
        crewId: "crew-halcones",
        name: "Ruta Sector B",
        sectorName: "Sector B",
        updatedAt: "2026-08-09T16:20:00.000Z",
        revisions: [
          makeRevision(
            "revision-b-1",
            1,
            "PUBLISHED",
            sectorBPoints,
            "2026-08-08T11:00:00.000Z",
            "2026-08-09T16:20:00.000Z",
          ),
        ],
      },
    ],
    "crew-costa": [
      {
        id: "route-costa",
        crewId: "crew-costa",
        name: "Ruta Costanera",
        sectorName: "Costanera Norte",
        updatedAt: "2026-08-05T12:00:00.000Z",
        revisions: [
          makeRevision(
            "revision-costa-1",
            1,
            "ARCHIVED",
            sectorBPoints,
            "2026-08-05T10:00:00.000Z",
            "2026-08-05T12:00:00.000Z",
          ),
        ],
      },
    ],
    "crew-empty": [],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function latestRevision(route: RouteDetail): RouteRevision {
  return [...route.revisions].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  )[0];
}

function toSummary(route: RouteDetail): RouteSummary {
  const latest = latestRevision(route);
  return {
    id: route.id,
    name: route.name,
    sectorName: route.sectorName,
    updatedAt: route.updatedAt,
    latestRevision: {
      id: latest.id,
      number: latest.number,
      status: latest.status,
      pointCount: latest.pointCount,
      createdAt: latest.createdAt,
      publishedAt: latest.publishedAt,
      contentHash: latest.contentHash,
    },
  };
}

function toCampaignSummary(campaign: CampaignDetail): CampaignSummary {
  const { routes: _routes, ...summary } = campaign;
  return summary;
}

export function createDemoAdminApi(options: DemoApiOptions = {}): AdminApi {
  const delayMs = options.delayMs ?? 280;
  const routesByCrew = createInitialRoutes();
  const importsByKey = new Map<string, ImportRouteResponse>();
  const editsByKey = new Map<string, { csv: string; response: EditRevisionPointsResponse }>();
  const mapOperations = new Map<
    string,
    {
      fingerprint: string;
      result: {
        routeId: string;
        revisionId: string;
        draftVersion: number;
        pointCount: number;
        segmentCount: number;
        replayed: boolean;
      };
    }
  >();
  const segmentsByRevision = new Map<string, RevisionStreetSegment[]>(
    Object.entries(INITIAL_SEGMENTS_BY_REVISION).map(([revisionId, segments]) => [
      revisionId,
      clone(segments),
    ]),
  );
  for (const routes of Object.values(routesByCrew)) {
    for (const route of routes) {
      for (const revision of route.revisions) {
        revision.segmentCount = segmentsByRevision.get(revision.id)?.length ?? 0;
      }
    }
  }
  const vehiclesByCrew: Record<string, Vehicle[]> = {
    "crew-halcones": [
      {
        id: "vehicle-halcones-1",
        name: "Camión 1",
        registration: "RC-01",
        status: "ACTIVE",
        createdAt: "2026-08-11T09:00:00.000Z",
      },
    ],
  };
  const campaignsByCrew: Record<string, CampaignDetail[]> = {};
  let sequence = 1;
  let token: string | null = null;

  async function wait(): Promise<void> {
    if (delayMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
  }

  function requireSession(): void {
    if (!token) {
      throw new ApiError(401, "La sesión de demostración expiró.");
    }
  }

  function requireCrew(crewId: string): RouteDetail[] {
    requireSession();
    if (!DEMO_MEMBERSHIPS.some((membership) => membership.crewId === crewId)) {
      throw new ApiError(403, "No perteneces a esta tripulación.");
    }
    if (crewId === "crew-forbidden") {
      throw new ApiError(403, "Tu membresía no permite administrar las rutas de esta tripulación.");
    }
    if (crewId === "crew-error") {
      throw new ApiError(503, "El servicio de rutas no está disponible temporalmente.");
    }
    return routesByCrew[crewId] ?? [];
  }

  function requireCampaign(crewId: string, campaignId: string): CampaignDetail {
    requireCrew(crewId);
    const campaign = (campaignsByCrew[crewId] ?? []).find(
      (candidate) => candidate.id === campaignId,
    );
    if (!campaign) {
      throw new ApiError(404, "La campaña solicitada no existe.", undefined, "CAMPAIGN_NOT_FOUND");
    }
    return campaign;
  }

  function requireDraftCampaign(crewId: string, campaignId: string): CampaignDetail {
    const campaign = requireCampaign(crewId, campaignId);
    if (campaign.status !== "DRAFT") {
      throw new ApiError(
        409,
        "La composición de una campaña activa es de solo lectura.",
        undefined,
        "CAMPAIGN_INVALID_STATE",
      );
    }
    return campaign;
  }

  return {
    setToken(nextToken) {
      token = nextToken;
    },

    async login(email, password): Promise<LoginResponse> {
      await wait();
      if (email.trim().toLocaleLowerCase("es") !== "admin@demo.cl" || password !== "demo1234") {
        throw new ApiError(401, "Correo o contraseña incorrectos.");
      }
      token = "demo-token-rutacuadrilla";
      return {
        token,
        expiresAt: "2026-08-12T23:59:59.000Z",
        user: clone(DEMO_USER),
        memberships: clone(DEMO_MEMBERSHIPS),
      };
    },

    async me(): Promise<MeResponse> {
      await wait();
      requireSession();
      return {
        user: clone(DEMO_USER),
        memberships: clone(DEMO_MEMBERSHIPS),
      };
    },

    async logout(): Promise<void> {
      await wait();
      token = null;
    },

    async listRoutes(crewId): Promise<RouteSummary[]> {
      await wait();
      return clone(requireCrew(crewId).map(toSummary));
    },

    async getRoute(crewId, routeId): Promise<RouteDetail> {
      await wait();
      const route = requireCrew(crewId).find((candidate) => candidate.id === routeId);
      if (!route) {
        throw new ApiError(404, "La ruta solicitada no existe.");
      }
      return clone(route);
    },

    async importRoute(crewId, input: ImportRouteRequest): Promise<ImportRouteResponse> {
      await wait();
      const routes = requireCrew(crewId);
      const idempotencyKey = `${crewId}:${input.importKey}`;
      const previous = importsByKey.get(idempotencyKey);
      if (previous) {
        return clone(previous);
      }

      const preview = parseRouteCsv(input.csv);
      const issues = [
        ...preview.globalErrors.map((message) => ({ row: 1, message })),
        ...preview.rows.flatMap((row) =>
          row.errors.map((message) => ({ row: row.rowNumber, message })),
        ),
      ];
      if (issues.length > 0 || preview.validRows.length === 0) {
        throw new ApiError(422, "El CSV contiene errores y no se creó el borrador.", issues);
      }

      const now = new Date().toISOString();
      const routeId = `route-import-${input.importKey}`;
      const points: RoutePoint[] = preview.validRows.map((row, index) => ({
        id: `${routeId}-point-${index + 1}`,
        externalId: row.externalId,
        servicePointVersionId: `${routeId}-point-version-${index + 1}`,
        street: row.street || undefined,
        number: row.number || undefined,
        latitude: row.latitude as number,
        longitude: row.longitude as number,
        pointType: row.pointType as RoutePoint["pointType"],
        source: row.source as RoutePoint["source"],
      }));
      const revision = makeRevision(`${routeId}-revision-1`, null, "DRAFT", points, now);
      const route: RouteDetail = {
        id: routeId,
        crewId,
        name: input.routeName.trim(),
        sectorName: input.sectorName.trim(),
        revisions: [revision],
        updatedAt: now,
      };
      routes.unshift(route);

      const response = { route: clone(route), revision: clone(revision) };
      importsByKey.set(idempotencyKey, response);
      return clone(response);
    },

    async editRevisionPoints(
      crewId,
      routeId,
      revisionId,
      input: EditRevisionPointsRequest,
    ): Promise<EditRevisionPointsResponse> {
      await wait();
      const route = requireCrew(crewId).find((candidate) => candidate.id === routeId);
      if (!route) {
        throw new ApiError(404, "La ruta solicitada no existe.");
      }
      const revision = route.revisions.find((candidate) => candidate.id === revisionId);
      if (!revision) {
        throw new ApiError(404, "La revisión solicitada no existe.");
      }
      if (revision.status !== "DRAFT") {
        throw new ApiError(409, "Solo pueden corregirse los puntos de un borrador.");
      }

      const idempotencyKey = [crewId, routeId, revisionId, input.editKey].join(":");
      const previous = editsByKey.get(idempotencyKey);
      if (previous) {
        if (previous.csv !== input.csv) {
          throw new ApiError(409, "La clave de edición ya se utilizó con otro CSV.");
        }
        return clone(previous.response);
      }

      const preview = parseRouteCsv(input.csv);
      const issues = [
        ...preview.globalErrors.map((message) => ({ row: 1, message })),
        ...preview.rows.flatMap((row) =>
          row.errors.map((message) => ({ row: row.rowNumber, message })),
        ),
      ];
      if (issues.length > 0 || preview.validRows.length === 0) {
        throw new ApiError(422, "El CSV contiene errores y no se guardaron cambios.", issues);
      }

      const now = new Date().toISOString();
      revision.points = preview.validRows.map((row, index) => {
        const existingPoint = revision.points.find(
          (point) =>
            point.source === row.source &&
            point.externalId.toLocaleLowerCase("en") === row.externalId.toLocaleLowerCase("en"),
        );
        return {
          id: existingPoint?.id ?? `${revisionId}-point-${index + 1}`,
          externalId: row.externalId,
          servicePointVersionId: `${revisionId}-edit-${input.editKey}-version-${index + 1}`,
          street: row.street || undefined,
          number: row.number || undefined,
          latitude: row.latitude as number,
          longitude: row.longitude as number,
          pointType: row.pointType as RoutePoint["pointType"],
          source: row.source as RoutePoint["source"],
        };
      });
      revision.pointCount = revision.points.length;
      route.updatedAt = now;
      const response: EditRevisionPointsResponse = {
        route: clone(route),
        revision: clone(revision),
        errors: [],
      };
      editsByKey.set(idempotencyKey, { csv: input.csv, response: clone(response) });
      return clone(response);
    },

    async publishRevision(crewId, routeId, revisionId): Promise<RouteDetail> {
      await wait();
      const route = requireCrew(crewId).find((candidate) => candidate.id === routeId);
      if (!route) {
        throw new ApiError(404, "La ruta solicitada no existe.");
      }
      const revision = route.revisions.find((candidate) => candidate.id === revisionId);
      if (!revision) {
        throw new ApiError(404, "La revisión solicitada no existe.");
      }
      if (revision.status !== "DRAFT") {
        throw new ApiError(409, "Solo una revisión en borrador puede publicarse.");
      }

      const now = new Date().toISOString();
      route.revisions.forEach((candidate) => {
        if (candidate.status === "PUBLISHED") {
          candidate.status = "SUPERSEDED";
        }
      });
      if (revision.number === null) {
        revision.number =
          Math.max(
            0,
            ...route.revisions
              .filter((candidate) => candidate.id !== revision.id)
              .map((candidate) => candidate.number ?? 0),
          ) + 1;
      }
      revision.status = "PUBLISHED";
      revision.publishedAt = now;
      revision.contentHash = `demo-content:${revision.id}`;
      route.updatedAt = now;
      return clone(route);
    },

    async getRevisionFeatures(crewId, routeId, revisionId): Promise<RevisionFeatures> {
      await wait();
      const route = requireCrew(crewId).find((candidate) => candidate.id === routeId);
      const revision = route?.revisions.find((candidate) => candidate.id === revisionId);
      if (!route || !revision) throw new ApiError(404, "La revisión solicitada no existe.");
      const segments = segmentsByRevision.get(revisionId) ?? [];
      const allLongitudes = revision.points.map((point) => point.longitude);
      const allLatitudes = revision.points.map((point) => point.latitude);
      return clone({
        schemaVersion: 1,
        routeId,
        revisionId,
        status: revision.status,
        draftVersion: revision.draftVersion ?? 0,
        contentHash: revision.contentHash,
        pointCount: revision.points.length,
        segmentCount: segments.length,
        bounds:
          revision.points.length > 0
            ? [
                Math.min(...allLongitudes),
                Math.min(...allLatitudes),
                Math.max(...allLongitudes),
                Math.max(...allLatitudes),
              ]
            : null,
        area: revision.area ?? null,
        points: revision.points.map((point, displayOrder) => ({ ...point, displayOrder })),
        segments,
      });
    },

    async applyDraftChange(crewId, routeId, revisionId, input) {
      await wait();
      const route = requireCrew(crewId).find((candidate) => candidate.id === routeId);
      const revision = route?.revisions.find((candidate) => candidate.id === revisionId);
      if (!route || !revision) throw new ApiError(404, "La revisión solicitada no existe.");
      if (revision.status !== "DRAFT")
        throw new ApiError(409, "Solo puede modificarse un borrador.");
      const fingerprint = JSON.stringify(input);
      const previous = mapOperations.get(`${crewId}:${input.operationId}`);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ApiError(409, "La clave ya se utilizó con otro contenido.");
        return clone({ ...previous.result, replayed: true });
      }
      if ((revision.draftVersion ?? 0) !== input.baseDraftVersion) {
        throw new ApiError(409, "El borrador cambió en otra sesión.");
      }
      const change: DraftRevisionChange = input.change;
      const segments = segmentsByRevision.get(revisionId) ?? [];
      if (change.type === "SET_AREA")
        revision.area =
          change.geometry?.type === "Polygon"
            ? { type: "MultiPolygon", coordinates: [change.geometry.coordinates] }
            : change.geometry;
      if (change.type === "ADD_POINT") {
        revision.points.push({
          id: `demo-point-${crypto.randomUUID()}`,
          servicePointVersionId: `demo-version-${crypto.randomUUID()}`,
          ...change.point,
        });
      }
      if (change.type === "UPDATE_POINT") {
        const point = revision.points.find((candidate) => candidate.id === change.servicePointId);
        if (!point) throw new ApiError(404, "El punto no existe.");
        Object.assign(point, change.point, {
          servicePointVersionId: `demo-version-${crypto.randomUUID()}`,
        });
      }
      if (change.type === "REMOVE_POINT") {
        revision.points = revision.points.filter(
          (candidate) => candidate.id !== change.servicePointId,
        );
      }
      if (change.type === "REPLACE_SEGMENTS" || change.type === "IMPORT_OSM_SELECTION") {
        const incoming = change.segments.map((segment, index) => ({
          id: `demo-segment-${crypto.randomUUID()}`,
          streetSegmentVersionId: `demo-segment-version-${crypto.randomUUID()}`,
          displayOrder: index,
          externalId: segment.externalId,
          geometry:
            segment.geometry.type === "LineString"
              ? { type: "MultiLineString" as const, coordinates: [segment.geometry.coordinates] }
              : segment.geometry,
          serviceSide: segment.serviceSide,
          source: segment.source,
          ...(segment.name ? { name: segment.name } : {}),
          ...(segment.sourceVersion ? { sourceVersion: segment.sourceVersion } : {}),
          ...(segment.attribution ? { attribution: segment.attribution } : {}),
        }));
        segmentsByRevision.set(
          revisionId,
          change.type === "REPLACE_SEGMENTS" ? incoming : [...segments, ...incoming],
        );
      }
      if (change.type === "IMPORT_OSM_SELECTION") {
        for (const point of change.points) {
          revision.points.push({
            id: `demo-point-${crypto.randomUUID()}`,
            servicePointVersionId: `demo-version-${crypto.randomUUID()}`,
            ...point,
          });
        }
      }
      revision.draftVersion = (revision.draftVersion ?? 0) + 1;
      revision.pointCount = revision.points.length;
      revision.segmentCount = segmentsByRevision.get(revisionId)?.length ?? 0;
      route.updatedAt = new Date().toISOString();
      const result = {
        routeId,
        revisionId,
        draftVersion: revision.draftVersion,
        pointCount: revision.pointCount,
        segmentCount: revision.segmentCount,
        replayed: false,
      };
      mapOperations.set(`${crewId}:${input.operationId}`, { fingerprint, result: clone(result) });
      return result;
    },

    async previewOsmExport(crewId, routeId, revisionId, exportPayload): Promise<OsmPreview> {
      await wait();
      const route = requireCrew(crewId).find((candidate) => candidate.id === routeId);
      const revision = route?.revisions.find((candidate) => candidate.id === revisionId);
      if (!revision) throw new ApiError(404, "La revisión solicitada no existe.");
      if (revision.status !== "DRAFT")
        throw new ApiError(409, "Solo puede modificarse un borrador.");
      const elements =
        typeof exportPayload === "object" &&
        exportPayload !== null &&
        "elements" in exportPayload &&
        Array.isArray(exportPayload.elements)
          ? (exportPayload.elements as Array<Record<string, unknown>>)
          : [];
      const points = elements.flatMap((element) => {
        const tags =
          typeof element.tags === "object" && element.tags !== null
            ? (element.tags as Record<string, unknown>)
            : {};
        if (
          element.type !== "node" ||
          typeof element.lat !== "number" ||
          typeof element.lon !== "number" ||
          typeof tags["addr:housenumber"] !== "string"
        )
          return [];
        return [
          {
            externalId: `node/${String(element.id)}`,
            latitude: element.lat,
            longitude: element.lon,
            number: tags["addr:housenumber"],
            street: typeof tags["addr:street"] === "string" ? tags["addr:street"] : undefined,
            pointType: "DWELLING" as const,
            source: "OSM" as const,
          },
        ];
      });
      const segments = elements.flatMap((element) => {
        const tags =
          typeof element.tags === "object" && element.tags !== null
            ? (element.tags as Record<string, unknown>)
            : {};
        const geometry = Array.isArray(element.geometry)
          ? (element.geometry as Array<Record<string, unknown>>)
          : [];
        const coordinates = geometry.flatMap((node) =>
          typeof node.lon === "number" && typeof node.lat === "number"
            ? [[node.lon, node.lat] as [number, number]]
            : [],
        );
        if (element.type !== "way" || typeof tags.highway !== "string" || coordinates.length < 2)
          return [];
        return [
          {
            externalId: `way/${String(element.id)}`,
            geometry: { type: "LineString" as const, coordinates },
            serviceSide: "BOTH" as const,
            source: "OSM" as const,
            attribution: "© OpenStreetMap contributors",
            ...(typeof tags.name === "string" ? { name: tags.name } : {}),
          },
        ];
      });
      return {
        attribution: "© OpenStreetMap contributors",
        points,
        segments,
        summary: {
          sourceElements: elements.length,
          candidatePoints: points.length,
          candidateSegments: segments.length,
        },
        warnings: ["La cobertura de OpenStreetMap puede estar incompleta; revisa cada candidato."],
      };
    },

    async listVehicles(crewId): Promise<Vehicle[]> {
      await wait();
      requireCrew(crewId);
      return clone(vehiclesByCrew[crewId] ?? []);
    },

    async createVehicle(crewId, input: CreateVehicleRequest): Promise<Vehicle> {
      await wait();
      requireCrew(crewId);
      const name = input.name.trim();
      const registration = input.registration?.trim();
      if (!name) {
        throw new ApiError(400, "Indica un nombre para el camión.", undefined, "INVALID_REQUEST");
      }
      let vehicles = vehiclesByCrew[crewId];
      if (!vehicles) {
        vehicles = [];
        vehiclesByCrew[crewId] = vehicles;
      }
      if (
        vehicles.some(
          (vehicle) => vehicle.name.toLocaleLowerCase("es") === name.toLocaleLowerCase("es"),
        )
      ) {
        throw new ApiError(
          409,
          "Ya existe un camión con ese nombre.",
          undefined,
          "VEHICLE_NAME_DUPLICATE",
        );
      }
      const vehicle: Vehicle = {
        id: `demo-vehicle-${sequence++}`,
        name,
        status: "ACTIVE",
        createdAt: new Date().toISOString(),
        ...(registration ? { registration } : {}),
      };
      vehicles.push(vehicle);
      return clone(vehicle);
    },

    async listCampaigns(crewId): Promise<CampaignSummary[]> {
      await wait();
      requireCrew(crewId);
      return clone((campaignsByCrew[crewId] ?? []).map(toCampaignSummary));
    },

    async getCampaign(crewId, campaignId): Promise<CampaignDetail> {
      await wait();
      return clone(requireCampaign(crewId, campaignId));
    },

    async createCampaign(crewId, input: CreateCampaignRequest): Promise<CampaignDetail> {
      await wait();
      requireCrew(crewId);
      const name = input.name.trim();
      if (!name || (input.startsOn && input.endsOn && input.startsOn > input.endsOn)) {
        throw new ApiError(
          400,
          "Revisa el nombre y el rango de fechas.",
          undefined,
          "INVALID_REQUEST",
        );
      }
      const now = new Date().toISOString();
      const campaign: CampaignDetail = {
        id: `demo-campaign-${sequence++}`,
        name,
        currency: input.currency?.trim().toLocaleUpperCase("en") || "CLP",
        timezone: input.timezone?.trim() || "America/Santiago",
        status: "DRAFT",
        routeCount: 0,
        pointCount: 0,
        routes: [],
        createdAt: now,
        updatedAt: now,
        ...(input.startsOn ? { startsOn: input.startsOn } : {}),
        ...(input.endsOn ? { endsOn: input.endsOn } : {}),
      };
      let campaigns = campaignsByCrew[crewId];
      if (!campaigns) {
        campaigns = [];
        campaignsByCrew[crewId] = campaigns;
      }
      campaigns.unshift(campaign);
      return clone(campaign);
    },

    async assignCampaignRoute(crewId, campaignId, input) {
      await wait();
      const campaign = requireDraftCampaign(crewId, campaignId);
      const vehicle = (vehiclesByCrew[crewId] ?? []).find(
        (candidate) => candidate.id === input.vehicleId && candidate.status === "ACTIVE",
      );
      if (!vehicle) {
        throw new ApiError(409, "El camión no está activo.", undefined, "VEHICLE_NOT_ACTIVE");
      }
      const route = requireCrew(crewId).find((candidate) =>
        candidate.revisions.some((revision) => revision.id === input.routeRevisionId),
      );
      const revision = route?.revisions.find((candidate) => candidate.id === input.routeRevisionId);
      if (!route || !revision || !["PUBLISHED", "SUPERSEDED"].includes(revision.status)) {
        throw new ApiError(
          409,
          "La revisión no puede asignarse.",
          undefined,
          "CAMPAIGN_ROUTE_REVISION_INVALID",
        );
      }
      const sameRevision = campaign.routes.find(
        (assignment) => assignment.routeRevisionId === revision.id,
      );
      if (sameRevision?.vehicle.id === vehicle.id) {
        return { assignment: clone(sameRevision), created: false };
      }
      if (sameRevision) {
        throw new ApiError(
          409,
          "La ruta ya está asignada.",
          {
            conflict: {
              campaignRouteId: sameRevision.id,
              route: { id: sameRevision.routeId, name: sameRevision.routeName },
              routeRevisionId: sameRevision.routeRevisionId,
            },
          },
          "CAMPAIGN_ROUTE_DUPLICATE",
        );
      }
      const sameVehicle = campaign.routes.find(
        (assignment) => assignment.vehicle.id === vehicle.id,
      );
      if (sameVehicle) {
        throw new ApiError(
          409,
          "El camión ya está asignado.",
          {
            conflict: {
              campaignRouteId: sameVehicle.id,
              route: { id: sameVehicle.routeId, name: sameVehicle.routeName },
              vehicle: { id: vehicle.id, name: vehicle.name },
            },
          },
          "CAMPAIGN_VEHICLE_DUPLICATE",
        );
      }
      const pointConflicts = campaign.routes.flatMap((assignment) => {
        const assignedRoute = requireCrew(crewId).find(
          (candidate) => candidate.id === assignment.routeId,
        );
        const assignedRevision = assignedRoute?.revisions.find(
          (candidate) => candidate.id === assignment.routeRevisionId,
        );
        const assignedIds = new Set(assignedRevision?.points.map((point) => point.id) ?? []);
        return revision.points
          .filter((point) => assignedIds.has(point.id))
          .map((point) => ({
            campaignRouteId: assignment.id,
            servicePointId: point.id,
            servicePointExternalId: point.externalId,
          }));
      });
      if (pointConflicts.length > 0) {
        throw new ApiError(
          409,
          "Hay puntos repetidos entre rutas.",
          { conflictCount: pointConflicts.length, conflicts: pointConflicts },
          "CAMPAIGN_POINT_DUPLICATE",
        );
      }
      const physicalClaims = (segmentsByRevision.get(revision.id) ?? []).flatMap((segment) =>
        (segment.serviceSide === "BOTH" ? ["LEFT", "RIGHT"] : [segment.serviceSide]).map(
          (physicalSide) => ({
            source: segment.source,
            externalId: segment.externalId.trim().toLocaleLowerCase("en"),
            physicalSide,
            streetSegmentId: segment.id,
            streetSegmentVersionId: segment.streetSegmentVersionId,
          }),
        ),
      );
      const sideConflicts = campaign.routes.flatMap((assignment) => {
        const existingClaims = (segmentsByRevision.get(assignment.routeRevisionId) ?? []).flatMap(
          (segment) =>
            (segment.serviceSide === "BOTH" ? ["LEFT", "RIGHT"] : [segment.serviceSide]).map(
              (physicalSide) => ({
                source: segment.source,
                externalId: segment.externalId.trim().toLocaleLowerCase("en"),
                physicalSide,
                streetSegmentId: segment.id,
                streetSegmentVersionId: segment.streetSegmentVersionId,
              }),
            ),
        );
        const versionAmbiguities = physicalClaims.flatMap((claim) =>
          existingClaims
            .filter(
              (existing) =>
                existing.source === claim.source &&
                existing.externalId === claim.externalId &&
                existing.physicalSide !== claim.physicalSide &&
                (existing.streetSegmentId !== claim.streetSegmentId ||
                  existing.streetSegmentVersionId !== claim.streetSegmentVersionId),
            )
            .map((existing) => ({
              campaignRouteId: assignment.id,
              source: claim.source,
              externalId: claim.externalId,
              existingPhysicalSide: existing.physicalSide,
              requestedPhysicalSide: claim.physicalSide,
              existingStreetSegmentId: existing.streetSegmentId,
              existingStreetSegmentVersionId: existing.streetSegmentVersionId,
              requestedStreetSegmentId: claim.streetSegmentId,
              requestedStreetSegmentVersionId: claim.streetSegmentVersionId,
            })),
        );
        if (versionAmbiguities.length > 0) {
          throw new ApiError(
            409,
            "Los lados opuestos no corresponden a la misma versión de calle.",
            {
              conflictCount: versionAmbiguities.length,
              conflicts: versionAmbiguities,
              matchingRule: "source+externalId+complementaryPhysicalSide",
              spatialInferenceUsed: false,
            },
            "CAMPAIGN_SEGMENT_VERSION_AMBIGUOUS",
          );
        }
        return physicalClaims
          .filter((claim) =>
            existingClaims.some(
              (existing) =>
                existing.source === claim.source &&
                existing.externalId === claim.externalId &&
                existing.physicalSide === claim.physicalSide,
            ),
          )
          .map((claim) => ({ campaignRouteId: assignment.id, ...claim }));
      });
      if (sideConflicts.length > 0) {
        throw new ApiError(
          409,
          "Hay lados de calle repetidos entre rutas.",
          {
            conflictCount: sideConflicts.length,
            conflicts: sideConflicts,
            matchingRule: "source+externalId+physicalSide",
            spatialInferenceUsed: false,
          },
          "CAMPAIGN_SEGMENT_SIDE_DUPLICATE",
        );
      }
      const assignment: CampaignRouteAssignment = {
        id: `demo-campaign-route-${sequence++}`,
        routeId: route.id,
        routeName: route.name,
        routeRevisionId: revision.id,
        routeContentHash: revision.contentHash ?? `demo-content:${revision.id}`,
        pointCount: revision.pointCount,
        segmentSideClaimCount: physicalClaims.length,
        status: "ACTIVE",
        vehicle: clone(vehicle),
        createdAt: new Date().toISOString(),
      };
      campaign.routes.push(assignment);
      campaign.routeCount = campaign.routes.length;
      campaign.pointCount = campaign.routes.reduce(
        (total, candidate) => total + candidate.pointCount,
        0,
      );
      campaign.updatedAt = new Date().toISOString();
      return { assignment: clone(assignment), created: true };
    },

    async removeCampaignRoute(crewId, campaignId, campaignRouteId): Promise<CampaignDetail> {
      await wait();
      const campaign = requireDraftCampaign(crewId, campaignId);
      const previousLength = campaign.routes.length;
      campaign.routes = campaign.routes.filter((assignment) => assignment.id !== campaignRouteId);
      if (campaign.routes.length === previousLength) {
        throw new ApiError(404, "La asignación no existe.", undefined, "CAMPAIGN_ROUTE_NOT_FOUND");
      }
      campaign.routeCount = campaign.routes.length;
      campaign.pointCount = campaign.routes.reduce(
        (total, candidate) => total + candidate.pointCount,
        0,
      );
      campaign.updatedAt = new Date().toISOString();
      return clone(campaign);
    },

    async activateCampaign(crewId, campaignId): Promise<CampaignDetail> {
      await wait();
      const campaign = requireDraftCampaign(crewId, campaignId);
      if (campaign.routes.length === 0) {
        throw new ApiError(
          409,
          "Asigna al menos una ruta y un camión.",
          undefined,
          "CAMPAIGN_EMPTY",
        );
      }
      campaign.status = "ACTIVE";
      campaign.updatedAt = new Date().toISOString();
      return clone(campaign);
    },

    async getCurrentWorkSession(crewId, campaignRouteId): Promise<CurrentWorkSessionResponse> {
      await wait();
      requireCrew(crewId);
      const assignmentExists = (campaignsByCrew[crewId] ?? []).some((campaign) =>
        campaign.routes.some((assignment) => assignment.id === campaignRouteId),
      );
      if (!assignmentExists) {
        throw new ApiError(
          404,
          "La ruta de campaña no existe.",
          undefined,
          "CAMPAIGN_ROUTE_NOT_FOUND",
        );
      }
      return { workSession: null };
    },

    async createTechnicalContext(crewId, routeRevisionId, campaignName) {
      await wait();
      const route = requireCrew(crewId).find((candidate) =>
        candidate.revisions.some((revision) => revision.id === routeRevisionId),
      );
      const revision = route?.revisions.find((candidate) => candidate.id === routeRevisionId);
      if (!route || !revision) throw new ApiError(404, "La revisión solicitada no existe.");
      if (revision.status === "DRAFT")
        throw new ApiError(409, "Primero debes publicar la revisión.");
      const segments = segmentsByRevision.get(routeRevisionId) ?? [];
      return {
        contractVersion: "p0-provisional-v3",
        context: {
          campaignId: `demo-campaign-${routeRevisionId}`,
          id: `demo-context-${routeRevisionId}`,
          campaignName: campaignName?.trim() || "Contexto técnico de demostración",
          contentHash: revision.contentHash ?? `demo-content:${routeRevisionId}`,
          pointCount: revision.pointCount,
          routeId: route.id,
          routeName: route.name,
          routeRevisionId,
          segmentCount: segments.length,
        },
        points: revision.points.map((point, displayOrder) => ({
          displayOrder,
          displayState: "SIN_VISITAR" as const,
          externalId: point.externalId,
          id: `demo-campaign-point-${point.id}`,
          latitude: point.latitude,
          longitude: point.longitude,
          pointType: point.pointType,
          servicePointId: point.id,
          servicePointVersionId: point.servicePointVersionId,
          version: 0,
          ...(point.number ? { number: point.number } : {}),
          ...(point.street ? { street: point.street } : {}),
        })),
        segments: clone(segments),
      };
    },
  };
}
